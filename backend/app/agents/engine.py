"""Agenti di sfondo: tengono aggiornati i moduli e alimentano Sintesi e Avvisi.

Ogni agente ricalcola i dati del proprio dominio con la sua cadenza, pubblica "finding" per l'Analista e messaggi sul bus
(richieste, conferme, allerte) e, a ogni giro riuscito, chiede al browser di ricaricare le query interessate (mappa
INVALIDATES -> {"type":"invalidate"} sul WebSocket). I moduli affini stanno in un solo agente (MultiAgent), con una cadenza
per ogni parte. Il ring buffer dei messaggi serve al motore degli avvisi (alerts.rule_agents).
"""
from __future__ import annotations

import asyncio
import importlib
import itertools
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from ..util import clean

log = logging.getLogger("agents")

Tone = str  # "bullish" | "bearish" | "neutral"


def _now() -> int:
    return int(time.time())


def _call(module: str, fn: str, **kw):
    """Chiama un builder di un router (import pigro, così un modulo rotto non blocca gli altri)."""
    mod = importlib.import_module(f"app.routers.{module}")
    return getattr(mod, fn)(**kw)


def _optional(module: str, fn: str, **kw) -> dict | None:
    """Come _call, per un dato accessorio: se manca l'agente continua con il resto."""
    try:
        return _call(module, fn, **kw)
    except Exception as e:  # noqa: BLE001
        log.info("%s.%s non disponibile: %s", module, fn, e)
        return None


def util_data(t) -> str:
    try:
        from ..util import data_it
        return data_it(t)
    except Exception:  # noqa: BLE001
        return "n/d"


def _k(x: float | None) -> str:
    if x is None:
        return "n/d"
    return f"{x / 1000:.1f}k" if abs(x) >= 1000 else f"{x:,.0f}"


def _usd(x: float | None) -> str:
    if x is None:
        return "n/d"
    sign = "−" if x < 0 else ""
    a = abs(x)
    for div, s in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "k")):
        if a >= div:
            return f"{sign}${a / div:.1f}{s}"
    return f"{sign}${a:,.0f}"


# ----------------------------------------------------------------------------- bus

class Bus:
    def __init__(self) -> None:
        self.messages: deque[dict] = deque(maxlen=600)
        self.ids = itertools.count(1)
        self.agents: dict[str, "Agent"] = {}

    def subscribers(self, topic: str) -> list["Agent"]:
        return [a for a in self.agents.values() if any(topic.startswith(s) for s in a.subscribes)]

    async def publish(self, sender: "Agent", topic: str, text: str, *, to: str = "*", kind: str = "finding",
                      tone: Tone = "neutral", data: dict | None = None) -> dict:
        msg = clean({
            "id": next(self.ids), "time": _now(), "from": sender.id, "to": to, "topic": topic,
            "kind": kind, "text": text, "tone": tone, "data": data or {},
        })
        self.messages.appendleft(msg)
        if kind == "alert":  # gli avvisi degli agenti passano al motore delle notifiche (dedupe per id)
            try:
                from .. import alerts
                alerts.ingest(msg)
            except Exception as e:  # noqa: BLE001
                log.debug("ingest avviso fallito: %s", e)
        targets = [self.agents[to]] if to != "*" and to in self.agents else [a for a in self.subscribers(topic) if a.id != sender.id]
        for t in targets:
            t.inbox.put_nowait(msg)
        return msg


bus = Bus()


async def _ws_push(msg: dict) -> None:
    try:
        from ..routers.stream import hub
        await hub._broadcast(msg)
    except Exception as e:  # noqa: BLE001
        log.debug("ws push fallito: %s", e)


# --------------------------------------------------------------------------- agent

@dataclass
class Finding:
    title: str
    text: str
    tone: Tone = "neutral"
    confidence: float = 60
    src: str | None = None   # fonte del track record se diversa dall'agente (i frattali, nell'agente analogs, restano "patterns")

    def as_dict(self) -> dict:
        return {"title": self.title, "text": self.text, "tone": self.tone, "confidence": round(self.confidence), "time": _now(), "src": self.src}


@dataclass
class Agent:
    id: str
    name: str
    interval_s: int
    subscribes: list[str] = field(default_factory=list)
    views: int = 2   # quanti finding (i più recenti, uno per titolo) entrano nel consenso dell'Analista

    def __post_init__(self) -> None:
        self.status = "idle"
        self.error: str | None = None
        self.last_run: int | None = None
        self.findings: deque[dict] = deque(maxlen=12)
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.state: dict[str, Any] = {}
        self._last_text: dict[str, str] = {}
        self._wake = asyncio.Event()

    # -- helpers
    def finding(self, f: Finding) -> None:
        """Una sola voce per titolo: i numeri cambiano a ogni giro, si aggiorna la voce invece di accodarne di nuove."""
        for i, x in enumerate(list(self.findings)):
            if x["title"] == f.title:
                del self.findings[i]
                break
        self.findings.appendleft(f.as_dict())

    async def say(self, topic: str, text: str, *, to: str = "*", kind: str = "finding", tone: Tone = "neutral",
                  data: dict | None = None, dedupe: bool = True) -> None:
        """Pubblica solo se il contenuto è cambiato (evita spam)."""
        key = f"{topic}->{to}"
        if dedupe and self._last_text.get(key) == text:
            return
        self._last_text[key] = text
        await bus.publish(self, topic, text, to=to, kind=kind, tone=tone, data=data)

    async def ask(self, other: str, topic: str, text: str, data: dict | None = None) -> None:
        await self.say(topic, text, to=other, kind="request", data=data)  # non ripete richieste identiche

    # -- da implementare
    def compute(self) -> dict:  # bloccante, gira in thread
        return {}

    async def act(self, result: dict) -> None:
        pass

    async def on_message(self, msg: dict) -> None:
        pass

    # -- ciclo
    async def run_once(self) -> None:
        self.status = "running"
        try:
            result = await asyncio.to_thread(self.compute)
            self.state.update(result or {})
            await self.act(result or {})
            self.error = None
            self.status = "idle"
        except Exception as e:  # noqa: BLE001
            log.warning("agente %s errore: %s", self.id, e)
            self.error = str(e)[:300]
            self.status = "error"
        self.last_run = _now()
        if self.status != "error":
            keys = INVALIDATES.get(self.id)
            if keys:  # i dati del modulo sono stati ricalcolati: il browser ricarica subito quelle query
                await _ws_push({"type": "invalidate", "source": self.id, "keys": keys, "time": self.last_run})

    def trigger(self) -> None:
        self._wake.set()

    async def loop(self, delay: float) -> None:
        await asyncio.sleep(delay)
        while True:
            await self.run_once()
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=self.interval_s)
            except asyncio.TimeoutError:
                pass

    async def inbox_loop(self) -> None:
        while True:
            msg = await self.inbox.get()
            try:
                await self.on_message(msg)
            except Exception as e:  # noqa: BLE001
                log.warning("agente %s on_message: %s", self.id, e)


class MultiAgent(Agent):
    """Agente che accorpa moduli affini. PARTS = (chiave, cadenza s, builder, handler): il builder (bloccante) restituisce un dict
    che finisce in self.state, l'handler ne ricava finding e messaggi. Ogni parte gira con la propria cadenza e una parte in
    errore non ferma le altre: l'agente va in errore (e non invalida) solo se in quel giro falliscono tutte."""

    PARTS: tuple[tuple[str, int, str, str], ...] = ()

    def __post_init__(self) -> None:
        super().__post_init__()
        self._ran: dict[str, float] = {}

    def refresh(self, key: str) -> None:
        """Forza la parte al prossimo giro (chiamare trigger() per anticiparlo)."""
        self._ran.pop(key, None)

    def compute(self) -> dict:
        out: dict[str, dict] = {}
        errors: list[str] = []
        for key, every, build, _ in self.PARTS:
            if time.time() - self._ran.get(key, 0) < every - 1:
                continue
            try:
                out[key] = getattr(self, build)()
                self._ran[key] = time.time()
            except Exception as e:  # noqa: BLE001
                log.warning("agente %s/%s: %s", self.id, key, e)
                errors.append(f"{key}: {e}")
        if errors and not out:
            raise RuntimeError("; ".join(errors))
        return {"parts": out}

    async def act(self, result: dict) -> None:
        parts = result.get("parts") or {}
        for key, _, _, handler in self.PARTS:
            if key not in parts:
                continue
            self.state.update(parts[key])
            try:
                await getattr(self, handler)(parts[key])
            except Exception as e:  # noqa: BLE001
                log.warning("agente %s/%s: %s", self.id, key, e)


# agente -> prefissi delle API i cui dati cambiano quando l'agente ricalcola (per l'aggiornamento live del frontend).
# "/derivatives" copre anche basis, CME e leva aggregata; "/usdt" anche gli analoghi USDT; "/alerts" anche le regole.
INVALIDATES: dict[str, list[str]] = {
    "analyst": ["/insights", "/scoreboard"],
    "market": ["/overview"],
    "levels": ["/levels", "/indicators"],
    "vwap": ["/vwap"],
    "liquidity": ["/liquidations"],
    "analogs": ["/fractals", "/analogs", "/usdt/analogs"],
    "usdt": ["/usdt", "/stablecoins"],
    "cycles": ["/cycles", "/cycle/advanced"],
    "onchain": ["/onchain"],
    "derivatives": ["/derivatives"],
    "flows": ["/flows"],
    "supply_demand": ["/supply-demand"],
    "timepivots": ["/timepivots"],
    "macro": ["/macro", "/events"],
    "structure": ["/structure"],
    "positioning": ["/positioning"],
    "anomalies": ["/anomalies", "/superchart/series"],
    "orderflow": ["/orderbook/status", "/orderbook/signals", "/terminal/status", "/terminal/signals"],
    "forecast": ["/forecast"],
    "verifier": ["/tracking"],
    "alerts": ["/alerts"],
}


_REL = {"t": 0.0, "w": {}}


def _reliability() -> dict[str, float]:
    """Pesi di affidabilità 0..1 per agente dal track record (cache 10 min)."""
    if time.time() - _REL["t"] > 600:
        try:
            from .. import tracking
            _REL["w"] = tracking.reliability_weights() or {}
        except Exception as e:  # noqa: BLE001
            log.info("pesi di affidabilità non disponibili: %s", e)
        _REL["t"] = time.time()
    return _REL["w"]


def peer(agent_id: str) -> Agent | None:
    return bus.agents.get(agent_id)


def live_price() -> float | None:
    try:
        return _call("market", "live_price")
    except Exception:  # noqa: BLE001
        m = peer("market")
        return m.state.get("price") if m else None


# ============================================================================ agenti

class MarketAgent(Agent):
    def compute(self):
        o = _call("market", "build_overview")
        return {"price": o["price"], "change_24h": o["change_24h"], "high_24h": o["high_24h"], "low_24h": o["low_24h"],
                "ath": o.get("ath", {}), "fng": o.get("fear_greed", {})}

    async def act(self, r):
        p = r["price"]
        last = self.state.get("announced")
        moved = last is None or abs(p / last - 1) >= 0.004
        if moved:
            self.state["announced"] = p
            tone = "bullish" if r["change_24h"] > 0 else "bearish" if r["change_24h"] < 0 else "neutral"
            await self.say("market.price", f"BTC a ${p:,.0f} ({r['change_24h']:+.2f}% 24h). Range 24h {_k(r['low_24h'])}–{_k(r['high_24h'])}.",
                           tone=tone, data={"price": p, "change_24h": r["change_24h"]})
        if p >= r["high_24h"] * 0.999 or p <= r["low_24h"] * 1.001:
            side = "massimo" if p >= r["high_24h"] * 0.999 else "minimo"
            await self.say("market.alert", f"Prezzo sul {side} delle 24h ({_k(p)}): possibile sweep di liquidità.",
                           kind="alert", tone="bullish" if side == "massimo" else "bearish", data={"price": p})
        fng = r.get("fng") or {}
        self.finding(Finding("Prezzo live", f"${p:,.0f} · {r['change_24h']:+.2f}% 24h · Fear&Greed {fng.get('value')} ({fng.get('label')})",
                             "bullish" if r["change_24h"] > 0 else "bearish", 90))


class LevelsAgent(Agent):
    def compute(self):
        return {"d1": _call("market", "build_levels", tf="1d"), "h4": _call("market", "build_levels", tf="4h")}

    def _all_levels(self) -> list[dict]:
        out = []
        for tf in ("d1", "h4"):
            lv = self.state.get(tf) or {}
            for k in lv.get("key_levels", []):
                out.append({"price": k["price"], "label": f"{k['label']} ({'1D' if tf == 'd1' else '4H'})", "kind": k["kind"]})
            for z in lv.get("zones", []):
                out.append({"price": (z["low"] + z["high"]) / 2, "label": f"zona di {'resistenza' if z['kind'] == 'resistance' else 'supporto'} {_k(z['low'])}–{_k(z['high'])} ({'1D' if tf == 'd1' else '4H'})", "kind": z["kind"]})
        return out

    def nearest(self, price: float, tol: float) -> dict | None:
        best = None
        for lv in self._all_levels():
            d = abs(lv["price"] / price - 1)
            if d <= tol and (best is None or d < best["d"]):
                best = {**lv, "d": d}
        return best

    async def act(self, r):
        lv = r["d1"]
        kl = lv.get("key_levels", [])
        res = [k for k in kl if k["kind"] == "resistance"]
        sup = [k for k in kl if k["kind"] == "support"]
        if res and sup:
            r1 = min(res, key=lambda k: abs(k["distance"]))
            s1 = min(sup, key=lambda k: abs(k["distance"]))
            text = f"Livelli chiave 1D: resistenza {_k(r1['price'])} ({r1['distance']:+.1f}%), supporto {_k(s1['price'])} ({s1['distance']:+.1f}%)."
            self.finding(Finding("Livelli chiave", text, "neutral", 75))
            await self.say("levels.key", text, data={"r1": r1["price"], "s1": s1["price"]})
        p = lv.get("pivots", {}).get("weekly", {}).get("classic", {})
        if p:
            self.finding(Finding("Pivot settimanale", f"P {_k(p.get('P'))} · R1 {_k(p.get('R1'))} · S1 {_k(p.get('S1'))}", "neutral", 70))

    async def on_message(self, m):
        topic, data = m["topic"], m.get("data") or {}
        if topic == "market.price" and data.get("price"):
            n = self.nearest(data["price"], 0.004)
            if n:
                tone = "bearish" if n["kind"] == "resistance" else "bullish"
                await self.say("levels.touch", f"Prezzo a {n['d'] * 100:.2f}% da {n['label']} ({_k(n['price'])}): reazione probabile.",
                               kind="alert", tone=tone, data={"price": n["price"]})
        elif topic == "request.levels":
            prices = data.get("prices") or ([data["price"]] if data.get("price") else [])
            hits = []
            for pr in prices:
                n = self.nearest(pr, 0.008)
                if n:
                    hits.append(f"{_k(pr)} ↔ {n['label']}")
            if hits:
                text = "Confluenza trovata: " + "; ".join(hits[:3]) + "."
                await self.say("levels.confluence", text, to=m["from"], kind="reply", tone="neutral", data={"hits": hits})
                await self.say("levels.confluence", text, to="analyst", kind="finding", tone="neutral", data={"hits": hits})
                self.finding(Finding("Confluenza", text, "neutral", 72))
            elif m["kind"] == "request":
                await self.say("levels.confluence", "Nessun livello chiave entro lo 0,8% dai prezzi richiesti.", to=m["from"], kind="reply", dedupe=False)


class LiquidityAgent(Agent):
    def compute(self):
        return {"liq": _call("liquidations", "build", range="7d"), "levmap": _optional("scoreboard", "leverage_map")}

    async def act(self, r):
        lq = r["liq"]
        mag = lq.get("magnet")
        cl = lq.get("clusters", [])[:4]
        if mag:
            side = "long" if mag["side"] == "long" else "short"
            tone = "bearish" if side == "long" else "bullish"  # magnete sotto = attrazione verso il basso
            text = f"Magnete di liquidità: {_usd(mag['usd'])} di liquidazioni {side} stimate a {_k(mag['price'])}."
            self.finding(Finding("Magnete di liquidità", text, tone, 70))
            await self.say("liquidity.cluster", text, tone=tone, data={"price": mag["price"], "prices": [c["price"] for c in cl], "usd": mag["usd"]})
            # chiede ai livelli se il cluster coincide con un supporto/resistenza
            await self.ask("levels", "request.levels", f"Il cluster a {_k(mag['price'])} coincide con un livello chiave?", {"prices": [c["price"] for c in cl]})
        t = lq.get("totals") or {}
        if t.get("long_24h") or t.get("short_24h"):
            self.finding(Finding("Liquidazioni 24h", f"Long {_usd(t.get('long_24h'))} · Short {_usd(t.get('short_24h'))}", "neutral", 85))
        lm = ((r.get("levmap") or {}).get("windows") or {}).get("7d")
        if lm:
            self.finding(Finding("Mappa per leva, 7 giorni", f"Stima, non ordini reali: {_usd(lm['short_above'])} di short sopra il prezzo, {_usd(lm['long_below'])} di long sotto.", "neutral", 50))

    async def on_message(self, m):
        data = m.get("data") or {}
        if m["topic"] == "market.price" and data.get("price"):
            mag = (self.state.get("liq") or {}).get("magnet")
            if mag and abs(data["price"] / mag["price"] - 1) < 0.003:
                await self.say("liquidity.sweep", f"Il prezzo sta raggiungendo il cluster {mag['side']} a {_k(mag['price'])}: sweep in corso.",
                               kind="alert", tone="neutral", data={"price": mag["price"]})
                self.trigger()
        elif m["topic"] == "request.liquidity":
            self.trigger()
        elif m["topic"] == "derivatives.oi":
            if abs(data.get("change_24h") or 0) > 3:
                self.trigger()  # l'OI è cambiato molto: ricalcolo la mappa


class AnalogsAgent(MultiAgent):
    """Somiglianze con lo storico: frattali, analogie grafiche (forma, candele, gambe, figure) e di struttura, analoghi della USDT dominance."""

    PARTS = (("analogs", 120, "_c_analogs", "_a_analogs"), ("fractals", 60, "_c_fractals", "_a_fractals"), ("usdt", 300, "_c_usdt", "_a_usdt"))

    def _c_fractals(self):
        return {"fh4": _call("fractals", "build", tf="4h", window=60, horizon=30, top=5),
                "fd1": _call("fractals", "build", tf="1d", window=60, horizon=30, top=5)}

    def _c_analogs(self):
        out = {"h4": _call("analogs", "build", tf="4h", top=5), "d1": _call("analogs", "build", tf="1d", top=5)}
        try:  # analogia di struttura (sequenza di massimi/minimi ZigZag) su BTC e USDT.D giornalieri
            out["struct"] = {a: _call("struct_analogs", "build", asset=a, tf="1d") for a in ("btc", "usdtd")}
        except Exception as e:  # noqa: BLE001
            log.warning("analogia di struttura non disponibile: %s", e)
        return out

    def _c_usdt(self):
        return {"u": _call("usdt_analogs", "build", tf="1d")}

    async def _a_fractals(self, r):
        for key, label in (("h4", "4H"), ("d1", "1D")):
            f = r["f" + key]
            pj = f.get("projection") or {}
            best = (f.get("matches") or [{}])[0]
            up = pj.get("up_prob")
            if up is None:
                continue
            tone = pj.get("bias", "neutral")
            p50 = (pj.get("p50") or [None])[-1]
            text = (f"Frattale {label}: miglior analogo {best.get('label')} (similarità {best.get('similarity', 0):.0f}%). "
                    f"Probabilità rialzo {up * 100 if up <= 1 else up:.0f}%, mediana a fine orizzonte {_k(p50)}.")
            self.finding(Finding(f"Frattale {label}", text, tone, min(90, best.get("similarity", 50)), src="patterns"))
            await self.say(f"pattern.projection.{key}", text, tone=tone, data={"tf": label, "up_prob": up, "p50": p50})
            await self._cross_check(key, label, tone)
        rt = r["fh4"].get("retests") or []
        if rt:
            prices = [x["price"] for x in rt[:4]]
            await self.say("pattern.retest", f"Gli analoghi indicano retest di: {', '.join(_k(p) for p in prices)}. Verifico con i livelli.",
                           data={"prices": prices})
            await self.ask("levels", "request.levels", "Questi prezzi di retest sono livelli chiave?", {"prices": prices})

    async def _cross_check(self, key: str, label: str, tone: str) -> None:
        """Analoghi grafici e frattali sullo stesso timeframe: concordano?"""
        mine = self.state.get(f"bias_{key}")
        if not mine or mine == "neutral" or tone == "neutral":
            return
        txt = (f"Analoghi grafici e frattali {label} concordano ({'rialzo' if mine == 'bullish' else 'ribasso'})." if mine == tone
               else f"Analoghi grafici e frattali {label} sono discordi: segnale {label} meno affidabile.")
        await self.say(f"analogs.check.{key}", txt, to="analyst", tone=mine if mine == tone else "neutral")

    async def _structure(self, st: dict) -> None:
        """Finding sobrio: prossimi pivot strutturali (mediana dei top-N, P25–P75) + verdetto del backtest walk-forward."""
        import pandas as pd

        from ..analysis.structure import dit_short
        verdict_it = {"strong": "significativo", "weak": "debole", "none": "nessun vantaggio sulle baseline", "anecdotal": "aneddotico (pochi casi)"}
        for asset, name in (("btc", "BTC"), ("usdtd", "USDT.D")):
            d = (st or {}).get(asset) or {}
            pr = (d.get("projection") or {}).get("pivots") or []
            bt = d.get("backtest") or {}
            if not pr or not bt.get("n"):
                continue
            p1 = pr[0]
            kind = "massimo" if p1["kind"] == "high" else "minimo"
            if asset == "btc":
                lvl = f"{_usd(p1['price'])} (P25–P75 {_usd(p1['lo'])}–{_usd(p1['hi'])})"
            else:
                b = p1.get("btc") or {}
                tr = d.get("translation") or {}
                lvl = (f"{p1['price']:.2f}% (P25–P75 {p1['lo']:.2f}–{p1['hi']:.2f}%)"
                       + (f", per BTC ≈ {_usd(b.get('price'))} (relazione swing per swing {'debole' if tr.get('strength') == 'weak' else 'moderata' if tr.get('strength') == 'moderate' else 'forte'}, R² {tr.get('r2', 0):.2f}"
                          + ("; nel backtest la traduzione non batte «BTC invariato»" if ((bt.get("btc") or {}).get("mase") or 9) >= 1 else "") + ")" if b else ""))
            when = "già toccato" if p1.get("reached") else f"verso {dit_short(pd.Timestamp(p1['t_lo'], unit='s'))}–{dit_short(pd.Timestamp(p1['t_hi'], unit='s'))}"
            m, bm = bt["model"], bt["base_median"]
            v = bt.get("verdict", "none")
            text = (f"{name} 1D, struttura degli ultimi {d['k']} swing (ZigZag {d['mult']}×ATR): prossimo pivot atteso {kind} {p1['label']} a {lvl}, {when}; "
                    f"mediana di {d['projection']['n']} analoghi. Backtest walk-forward su {bt['n']} casi: etichetta corretta {m['hit']:.0f}% "
                    f"(baseline {bm['hit']:.0f}%), errore di prezzo mediano {m['err_med']:.1f}% (baseline {bm['err_med']:.1f}%): verdetto {verdict_it.get(v, v)}. "
                    "Ipotesi di studio, non un segnale.")
            up = p1["change"] > 0 if asset == "btc" else p1["change"] < 0
            tone = ("bullish" if up else "bearish") if v in ("strong", "weak") else "neutral"
            self.finding(Finding(f"Struttura {name} 1D", text, tone, {"strong": 60, "weak": 45}.get(v, 30)))
            await self.say(f"analogs.structure.{asset}", text, tone=tone,
                           data={"asset": asset, "tf": "1d", "next": {"kind": p1["kind"], "label": p1["label"], "price": p1["price"],
                                                                     "lo": p1["lo"], "hi": p1["hi"], "t_lo": p1["t_lo"], "t_hi": p1["t_hi"]},
                                 "verdict": v, "n": bt["n"]})

    async def _a_analogs(self, r):
        if r.get("struct"):
            await self._structure(r["struct"])
        for key, label in (("h4", "4H"), ("d1", "1D")):
            a = r[key]
            ms = a.get("matches") or []
            if not ms:
                continue
            m, sm = ms[0], a.get("summary") or {}
            pats = (m.get("patterns") or {}).get("current") or []
            pat = f" Figura attuale: {pats[0]['name'].lower()} ({pats[0]['confidence']:.0f}%)." if pats else ""
            text = (f"{label}: il grafico somiglia a {m['period']['label']} (somiglianza grafica {m.get('visual_similarity') or 0:.0f}%, "
                    f"complessiva {m['similarity']:.0f}%).{pat} {sm.get('text', '')}").strip()
            tone = sm.get("bias", "neutral")
            self.finding(Finding(f"Analogo {label}", text, tone, min(90, m["similarity"])))
            self.state[f"bias_{key}"] = tone
            await self.say(f"analogs.match.{key}", text, tone=tone,
                           data={"tf": label, "period": m["period"]["label"], "similarity": m["similarity"],
                                 "pattern": pats[0]["key"] if pats else None, "median_outcome": sm.get("median_outcome")})
            if pats and pats[0]["confidence"] >= 75:
                await self.say(f"analogs.pattern.{key}", f"Figura {label} rilevata: {pats[0]['name']} (confidenza {pats[0]['confidence']:.0f}%).",
                               kind="alert", tone=pats[0].get("tone", "neutral"))

    async def _a_usdt(self, r):
        u = r["u"]
        ms, sm = u.get("matches") or [], u.get("summary") or {}
        if ms:
            m = ms[0]
            o = m.get("outcome") or {}
            text = (f"La USDT.D attuale somiglia a {m['period']['label']} (similarità {m['similarity']:.0f}%): dopo, BTC {o.get('change') or 0:+.1f}% "
                    f"in {o.get('candles')} candele. Sui {sm.get('count')} analoghi BTC è salito {sm.get('up')} volte (mediana {sm.get('median_outcome') or 0:+.1f}%).")
            tone = sm.get("bias", "neutral")
            self.finding(Finding("Analogo USDT.D", text, tone, min(85, m["similarity"])))
            await self.say("usdt_analogs.match", text, tone=tone, data={"median": sm.get("median_outcome")})
        mir = u.get("mirror")
        if isinstance(mir, dict) and mir.get("state"):
            self.finding(Finding("Specularità BTC/USDT.D", mir.get("text") or f"Stato: {mir['state']}", "neutral", 55))

    async def on_message(self, m):
        if m["topic"].startswith("correlation.usdt"):
            usdt_tone = m.get("tone")
            h4 = (self.state.get("fh4") or {}).get("projection") or {}
            if usdt_tone and h4.get("bias") and usdt_tone != "neutral":
                agree = usdt_tone == h4["bias"]
                txt = ("USDT.D conferma il bias del frattale 4H." if agree else "USDT.D diverge dal frattale 4H: segnale meno affidabile.")
                await self.say("pattern.confirmation", txt, to="analyst", tone=h4["bias"] if agree else "neutral")
            self.refresh("usdt")   # nuova lettura di dominance: ricalcolo gli analoghi USDT
            self.trigger()


class UsdtAgent(MultiAgent):
    """USDT dominance, correlazioni con BTC e liquidità in stablecoin (supply, emissione, dominance, SSR)."""

    PARTS = (("usdt", 60, "_c_dominance", "_a_dominance"), ("stables", 600, "_c_stables", "_a_stables"))

    def _c_dominance(self):
        return {"usdt": _call("usdt", "build")}

    def _c_stables(self):
        return {"s": _call("usdt_analogs", "build_stablecoins")}

    async def _a_dominance(self, r):
        u = r["usdt"]
        c, cur = u.get("correlation", {}), u.get("current", {})
        ch = cur.get("usdt_d_change_7d") or 0
        tone = "bullish" if ch < -0.05 else "bearish" if ch > 0.05 else "neutral"
        text = (f"USDT.D {cur.get('usdt_d', 0):.2f}% ({ch:+.2f} pt in 7g), correlazione 30g con BTC {c.get('current_30', 0):+.2f}. "
                f"Mint USDT 30g {_usd(cur.get('mint_30d'))}.")
        self.finding(Finding("USDT dominance", text, tone, 70))
        await self.say("correlation.usdt", text, tone=tone, data={"usdt_d": cur.get("usdt_d"), "change_7d": ch})
        dv = (u.get("divergences") or [])
        if dv:
            d = dv[-1]
            self.finding(Finding("Ultima divergenza", d.get("note", ""), d.get("kind", "neutral"), 60))
        fr = u.get("fractal") or {}
        if fr.get("matches"):
            mm = fr["matches"][0]
            await self.say("correlation.fractal", f"Frattale congiunto BTC+USDT.D: similarità {mm['similarity']:.0f}%, dopo l'orizzonte BTC {mm['btc_outcome']:+.1f}%.",
                           tone="bullish" if mm["btc_outcome"] > 0 else "bearish", to="analogs", data=mm)

    async def _a_stables(self, r):
        c = r["s"].get("current") or {}
        if c.get("supply"):
            n30 = c.get("net_30d") or 0
            tone = "bullish" if n30 > 0 else "bearish"
            text = (f"Stablecoin totali {_usd(c['supply'])} ({c.get('pct_30d') or 0:+.2f}% in 30g, emissione netta {_usd(n30)}), "
                    f"dominance {c.get('dominance') or 0:.2f}%, SSR {c.get('ssr') or 0:.2f} (z {c.get('ssr_z') or 0:+.2f}).")
            self.finding(Finding("Liquidità stablecoin", text, tone, 60))
            await self.say("stablecoins.liquidity", text, tone=tone, data={"net_30d": n30})
            n7 = c.get("net_7d") or 0
            if abs(n7) > 2e9:
                await self.say("stablecoins.alert", f"Movimento forte di stablecoin in 7 giorni: {_usd(n7)}.", kind="alert",
                               tone="bullish" if n7 > 0 else "bearish")


class CycleAgent(MultiAgent):
    """Ciclo: fase e modelli, orologio 0-100 con il confronto "stesso giorno del ciclo", miner (Hash Ribbons, Puell) e ciclo della leva."""

    PARTS = (("cycle", 300, "_c_cycle", "_a_phase"), ("advanced", 300, "_c_advanced", "_a_advanced"))

    def _c_cycle(self):
        return {"c": _call("cycles", "build")}

    def _c_advanced(self):
        return {"a": _call("cycle_advanced", "build")}

    async def _a_phase(self, r):
        cur = r["c"].get("current", {})
        phase = cur.get("phase", "?")
        names = {"accumulation": "accumulo", "bull": "bull market", "distribution": "distribuzione", "bear": "bear market"}
        tone = {"accumulation": "bullish", "bull": "bullish", "distribution": "bearish", "bear": "bearish"}.get(phase, "neutral")
        nt = cur.get("est_next_top") or {}
        text = (f"Fase di ciclo: {names.get(phase, phase)} (confidenza {cur.get('phase_confidence', 0):.0f}%), "
                f"{cur.get('days_since_top')} giorni dal top. Prossimo top stimato ~{time.strftime('%b %Y', time.gmtime(nt['mid'])) if nt.get('mid') else 'n/d'}.")
        self.finding(Finding("Fase di ciclo", text, tone, cur.get("phase_confidence", 60)))
        await self.say("cycle.phase", text, tone=tone, data={"phase": phase})
        pl = r["c"].get("models", {}).get("power_law", {})
        if pl:
            self.finding(Finding("Power law", f"Fair value {_k(pl.get('current_fair'))}, prezzo {pl.get('deviation', 0):+.0f}% rispetto al modello.",
                                 "bullish" if (pl.get("deviation") or 0) < 0 else "bearish", 65))

    async def _a_advanced(self, r):
        a = r["a"]
        await self._a_clock(r)
        await self._a_miner(a)
        await self._a_leverage(a)
        z = self.state.get("zone")
        ph = ((self.state.get("c") or {}).get("current") or {}).get("phase")
        if z and ph:
            ok = ((ph == "accumulation" and z in ("bottom", "accumulation", "mid"))
                  or (ph in ("bull", "distribution") and z in ("mid", "euphoria", "top")))
            await self.say("clock.check", ("Orologio del ciclo coerente con la fase stimata." if ok
                                           else "Orologio del ciclo e fase stimata non concordano: lettura del ciclo incerta."),
                           to="analyst", tone="neutral")

    async def _a_clock(self, r):
        a = r["a"]
        ck = a.get("clock") or {}
        if ck.get("score") is not None:
            sc = ck["score"]
            tone = "bullish" if sc < 40 else "bearish" if sc > 70 else "neutral"
            text = f"Orologio del ciclo {sc:.0f}/100 ({ck.get('zone_label')}), {ck.get('change_30d') or 0:+.0f} punti in 30 giorni."
            self.finding(Finding("Orologio del ciclo", text, tone, 70))
            prev = self.state.get("zone")
            await self.say("clock.score", text, tone=tone, data={"score": sc, "zone": ck.get("zone")})
            if prev and prev != ck.get("zone"):
                await self.say("clock.zone", f"L'orologio del ciclo è passato in zona {ck.get('zone_label')}.", kind="alert", tone=tone)
            self.state["zone"] = ck.get("zone")
        hl = (a.get("compare") or {}).get("highlights") or []
        for h in hl[:2]:
            self.finding(Finding("Stesso giorno del ciclo", h, "neutral", 55))
        if hl:
            await self.say("clock.compare", hl[0], to="analyst")

    async def _a_miner(self, r):
        mi = r["miner"]
        tone = "bullish" if mi.get("state") == "recovery" else "bearish" if mi.get("state") == "capitulation" else "neutral"
        text = (f"Hash Ribbons: {mi.get('label', '').lower()} da {mi.get('days_in_state')} giorni; hashrate {mi.get('hr_drawdown') or 0:+.0f}% dal massimo, "
                f"compressione Difficulty Ribbon {mi.get('ribbon_compression') or 0:.1f}%, Puell {mi.get('puell') or 0:.2f}.")
        self.finding(Finding("Ciclo dei miner", text, tone, 60))
        await self.say("miners.state", text, tone=tone, data={"state": mi.get("state")})
        if self.state.get("prev") and self.state["prev"] != mi.get("state"):
            await self.say("miners.signal", f"Cambio di stato dei miner: ora {mi.get('label', '').lower()}.", kind="alert", tone=tone)
        self.state["prev"] = mi.get("state")

    async def _a_leverage(self, r):
        lv = r["leverage"]
        pct = lv.get("funding_pct_all") or 0
        tone = "bearish" if pct > 85 else "bullish" if pct < 15 else "neutral"
        text = (f"Fase {lv.get('phase_label', '').lower()}: funding 7g {lv.get('funding_7d') or 0:+.1f}% annuo ({pct:.0f}° percentile dal 2019), "
                f"volumi perp/spot {lv.get('spec') or 0:.1f}× ({lv.get('spec_pct_all') or 0:.0f}° percentile), "
                f"OI pari allo {lv.get('leverage_ratio') or 0:.2f}% della market cap.")
        self.finding(Finding("Ciclo della leva", text, tone, 60))
        await self.say("leverage.cycle", text, tone=tone)

    async def on_message(self, m):
        if m["topic"].startswith("flows.spike"):
            await self.say("leverage.check", "Picco di flusso sui futures: verifico se la leva cresce oltre la norma di questa fase.", to="analyst")
            self.refresh("advanced")
            self.trigger()


class OnchainAgent(Agent):
    def compute(self):
        return {"o": _call("onchain", "build")}

    async def act(self, r):
        ms = {m["key"]: m for m in r["o"].get("metrics", [])}
        mv, rp = ms.get("mvrv"), ms.get("realized_price")
        if mv:
            text = f"MVRV {mv['display']} – {mv['status']}" + (f"; prezzo realizzato {rp['display']}." if rp else ".")
            self.finding(Finding("Valutazione on-chain", text, mv.get("tone", "neutral"), 70))
            await self.say("onchain.valuation", text, tone=mv.get("tone", "neutral"), data={"mvrv": mv["value"], "realized_price": rp["value"] if rp else None})
        hr = ms.get("hashrate")
        if hr:
            self.finding(Finding("Hashrate", f"{hr['display']} ({(hr.get('change_30d') or 0):+.1f}% 30g)", hr.get("tone", "neutral"), 60))


class DerivativesAgent(MultiAgent):
    """Leva sul mercato: funding, open interest, long/short e i segnali verificati di basis, CME COT e leva aggregata."""

    PARTS = (("market", 20, "_c_market", "_a_market"), ("agg_leverage", 300, "_c_aggregate", "_a_aggregate"),
             ("basis", 900, "_c_basis", "_a_basis"), ("cme", 3600, "_c_cme", "_a_cme"))

    def _c_market(self):
        return {"d": _call("derivatives", "build")}

    def _c_aggregate(self):
        return {"agg": _call("derivatives", "build_aggregate")}

    def _c_basis(self):
        return {"basis": _call("derivatives", "build_basis")}

    def _c_cme(self):
        return {"cme": _call("derivatives", "build_cme")}

    async def _a_market(self, r):
        d = r["d"]
        f, oi, ls = d.get("funding", {}), d.get("open_interest", {}), d.get("long_short", {})
        fr = f.get("current") or 0
        tone = "bearish" if fr > 0.03 else "bullish" if fr < -0.005 else "neutral"
        text = f"Funding {fr:+.4f}%/8h ({f.get('annualized', 0):+.1f}% annuo), OI {_usd(oi.get('current_usd'))} ({(oi.get('change_24h') or 0):+.1f}% 24h), long {ls.get('current_long_pct', 0):.0f}% degli account."
        self.finding(Finding("Leva e funding", text, tone, 70))
        await self.say("derivatives.funding", text, tone=tone, data={"funding": fr})
        await self.say("derivatives.oi", f"Open interest {(oi.get('change_24h') or 0):+.1f}% in 24h.", to="liquidity",
                       data={"change_24h": oi.get("change_24h")})
        for s in d.get("signals", [])[:2]:
            if s.get("tone") != "neutral":
                await self.say("derivatives.signal", s["text"], tone=s["tone"], kind="alert")

    async def _signals(self, topic: str, title: str, r: dict) -> None:
        sig = [x for x in (r.get("signals") or []) if x.get("text")]
        if not sig:
            return
        tones = [x.get("tone") for x in sig[:3]]
        tone = "bullish" if tones.count("bullish") > tones.count("bearish") else "bearish" if tones.count("bearish") > tones.count("bullish") else "neutral"
        text = " ".join(x["text"] for x in sig[:2])
        self.finding(Finding(title, text, tone, 55))
        await self.say(f"{topic}.state", text, tone=tone)

    async def _a_aggregate(self, r):
        await self._signals("agg_leverage", "Leva aggregata", r["agg"])

    async def _a_basis(self, r):
        await self._signals("basis", "Basis e curva futures", r["basis"])

    async def _a_cme(self, r):
        await self._signals("cme", "CME COT", r["cme"])


class FlowsAgent(Agent):
    """Pressione di acquisto/vendita aggressiva: spot vs futures perpetual."""

    def compute(self):
        return {"fl": _call("flows", "build", tf="1h", range="7d"), "f30": _optional("scoreboard", "flows_30d")}

    async def act(self, r):
        fl = r["fl"]
        wins = {w["label"]: w for w in fl.get("windows", [])}
        w24 = wins.get("24h")
        if w24:
            text = (f"24h: spot {_usd(w24['spot_delta'])} netti ({w24['spot_buy_pct']:.1f}% acquisti), "
                    f"futures {_usd(w24['perp_delta'])} ({w24['perp_buy_pct']:.1f}% acquisti), volume futures {w24['perp_spot_ratio']:.1f}× spot.")
            self.finding(Finding("Delta 24h spot/futures", text, (fl.get("current") or {}).get("bias", "neutral"), 70))
        for sg in (fl.get("signals") or [])[:2]:
            self.finding(Finding("Segnale flussi", sg["text"], sg["tone"], 65))
        s30 = (r.get("f30") or {}).get("summary")
        if s30:
            self.finding(Finding("Flussi a 30 giorni", f"ETF {_usd(s30['etf_30d'])}, USDT {_usd(s30['usdt_30d'])}, USDC {_usd(s30['usdc_30d'])} negli ultimi 30 giorni UTC chiusi.", "neutral", 55))
        top = (fl.get("signals") or [None])[0]
        if top:
            await self.say("flows.divergence", top["text"], tone=top["tone"],
                           data={"dominant": (fl.get("current") or {}).get("dominant"),
                                 "spot_24h": w24["spot_delta"] if w24 else None, "perp_24h": w24["perp_delta"] if w24 else None})
        w1 = wins.get("1h")
        if w1 and w24 and w24["perp_volume"]:
            # spike di 1h: delta futures oltre il 15% del volume orario medio delle 24h
            hourly = w24["perp_volume"] / 24
            if abs(w1["perp_delta"]) > 0.15 * hourly:
                side = "acquisti" if w1["perp_delta"] > 0 else "vendite"
                await self.say("flows.spike", f"Ultima ora: ondata di {side} aggressivi sui futures ({_usd(w1['perp_delta'])}).",
                               kind="alert", tone="bullish" if w1["perp_delta"] > 0 else "bearish")
                await self.ask("liquidity", "request.liquidity", "Picco di flusso sui futures: aggiorna la mappa delle liquidazioni.")

    async def on_message(self, m):
        if m["topic"] == "derivatives.funding":
            fr = (m.get("data") or {}).get("funding") or 0
            w24 = {w["label"]: w for w in (self.state.get("fl") or {}).get("windows", [])}.get("24h")
            if w24 and fr > 0.01 and w24["perp_delta"] > 0 > w24["spot_delta"]:
                await self.say("flows.leverage", "Funding positivo + futures in acquisto mentre lo spot vende: rialzo trainato dalla leva.",
                               to="analyst", kind="alert", tone="bearish")


EXPECTED_IT = {"rialzo": ("rialzo", "bullish"), "ribasso": ("ribasso", "bearish"),
               "inversione_rialzista": ("inversione al rialzo", "bullish"), "inversione_ribassista": ("inversione al ribasso", "bearish"),
               "inversione": ("inversione", "neutral"), "volatilita": ("volatilità", "neutral")}


class TimePivotsAgent(Agent):
    """Date e finestre temporali in cui BTC ha reagito in modo ricorrente (stagionalità, cicli, Fibonacci, eventi)."""

    def compute(self):
        return {"tp": _call("timepivots", "build", horizon=90)}

    async def act(self, r):
        tp = r["tp"]
        now = _now()
        cal = tp.get("calendar") or []
        nxt = (tp.get("kpi") or {}).get("next_pivot")
        if nxt:
            exp, tone = EXPECTED_IT.get(nxt.get("expected"), (nxt.get("expected"), "neutral"))
            prob = f", probabilità storica {nxt['probability']:.0f}%" if nxt.get("probability") else ""
            d0 = -(-(nxt["start"] - now) // 86400)  # giorni all'inizio della finestra (arrotondati per eccesso)
            when = "in corso" if d0 <= 0 else ("da domani" if d0 == 1 else f"tra {d0} giorni")
            text = (f"Prossimo pivot temporale: {nxt['label']} ({when}), atteso {exp}, "
                    f"confluenza {nxt['confluence']:.0f}/100{prob}.")
            self.finding(Finding("Prossimo pivot temporale", text, tone, nxt["confluence"]))
            self.state["next"] = {"expected": nxt.get("expected"), "tone": tone, "label": nxt["label"]}
            await self.say("timepivot.next", text, tone=tone, data={"start": nxt["start"], "end": nxt["end"], "expected": nxt.get("expected")})
        for it in cal:
            exp, tone = EXPECTED_IT.get(it.get("expected"), (it.get("expected"), "neutral"))
            active = it["start"] <= now <= it["end"]
            soon = 0 < it["start"] - now <= 3 * 86400
            if (active or soon) and it.get("confluence", 0) >= 70:
                when = "in corso" if active else "tra meno di 3 giorni"
                await self.say("timepivot.alert", f"Finestra {it['label']} {when}: atteso {exp} (confluenza {it['confluence']:.0f}).",
                               kind="alert", tone=tone, data={"id": it["id"]})
        top = sorted(cal, key=lambda x: -(x.get("confluence") or 0))[:1]
        if top and (not nxt or top[0]["id"] != nxt.get("id")):
            t = top[0]
            exp, tone = EXPECTED_IT.get(t.get("expected"), (t.get("expected"), "neutral"))
            self.finding(Finding("Pivot più forte (90 giorni)", f"{t['label']}: atteso {exp}, confluenza {t['confluence']:.0f}/100.", tone, t["confluence"]))
        cm = (tp.get("kpi") or {}).get("current_month") or {}
        if cm.get("win_rate") is not None:
            self.finding(Finding("Stagionalità del mese", f"Storicamente il mese corrente chiude positivo nel {cm['win_rate']:.0f}% degli anni (media {cm.get('avg', 0):+.1f}%).",
                                 "bullish" if cm["win_rate"] > 55 else "bearish" if cm["win_rate"] < 45 else "neutral", 55))

    async def on_message(self, m):
        if m["topic"] == "cycle.phase" and self.state.get("next"):
            phase = (m.get("data") or {}).get("phase")
            nx = self.state["next"]
            fits = (phase in ("accumulation", "bull") and nx["tone"] == "bullish") or (phase in ("distribution", "bear") and nx["tone"] == "bearish")
            txt = (f"Il pivot {nx['label']} è coerente con la fase di ciclo ({phase})." if fits
                   else f"Il pivot {nx['label']} va contro la fase di ciclo ({phase}): da trattare con cautela.")
            await self.say("timepivot.check", txt, to="analyst", tone=nx["tone"] if fits else "neutral")


class MacroAgent(MultiAgent):
    """Contesto macro (dollaro, tassi, volatilità, liquidità), rotazione BTC/altcoin e calendario (FOMC, CPI, lavoro, scadenze, midterm)."""

    PARTS = (("macro", 300, "_c_macro", "_a_macro"), ("events", 600, "_c_events", "_a_events"))

    def _c_macro(self):
        return {"m": _call("macro", "build")}

    def _c_events(self):
        return {"e": _call("events", "build", horizon=60)}

    async def _a_macro(self, r):
        m = r["m"]
        sm = m.get("summary") or {}
        if sm.get("score") is not None:
            neg = [c["label"] for c in sm.get("components", []) if c.get("tone") == "bearish"]
            pos = [c["label"] for c in sm.get("components", []) if c.get("tone") == "bullish"]
            text = (f"Contesto macro {sm['score']:.0f}/100 ({sm.get('label', '').lower()})."
                    + (f" A favore: {', '.join(pos)}." if pos else "") + (f" Contro: {', '.join(neg)}." if neg else ""))
            self.finding(Finding("Contesto macro", text, sm.get("tone", "neutral"), 60))
            await self.say("macro.context", text, tone=sm.get("tone", "neutral"), data={"score": sm["score"]})
        regime = None
        for c in sm.get("components", []):
            if c.get("key") == "dxy":
                regime = c.get("tone")
                self.finding(Finding("Dollaro (DXY)", f"{c.get('value')}: {c.get('text')}", c.get("tone", "neutral"), 60))
        if regime and self.state.get("dxy_regime") and regime != self.state["dxy_regime"]:
            await self.say("macro.alert", f"Cambio di regime del dollaro: ora {'favorevole' if regime == 'bullish' else 'sfavorevole' if regime == 'bearish' else 'neutrale'} per BTC.",
                           kind="alert", tone=regime)
        self.state["dxy_regime"] = regime
        alt = (m.get("rotation") or {}).get("altseason") or {}
        if alt.get("value") is not None:
            text = f"Indice altseason {alt['value']:.0f}/100 ({alt.get('phase_label', '').lower()})."
            self.finding(Finding("Rotazione BTC/altcoin", text, "neutral", 55))
            await self.say("macro.rotation", text, data={"altseason": alt["value"]})

    async def _a_events(self, r):
        up = r["e"].get("upcoming") or []
        if up:
            ev = up[0]
            text = (f"Prossimo evento: {ev.get('title')} il {ev.get('date_label')} ({ev.get('type_label')}), "
                    f"movimento atteso ±{ev.get('expected_abs_1d', 0):.1f}% nei 3 giorni attorno (n={ev.get('n')}).")
            self.finding(Finding("Prossimo evento", text, "neutral", 60))
            await self.say("events.next", text, data={"id": ev.get("id"), "days_away": ev.get("days_away")})
            soon = [x for x in up if (x.get("days_away") or 99) <= 1 and x.get("importance") == "alta"]
            for x in soon[:2]:
                await self.say("events.soon", f"{x.get('title')} entro 24 ore: volatilità storicamente ×{x.get('vol_ratio_1d') or 1:.2f}.",
                               to="analyst", tone="neutral", data={"id": x.get("id")})
        pol = r["e"].get("political") or {}
        if isinstance(pol, dict) and pol.get("text"):
            txt = pol["text"]
            txt = " ".join(txt[:2]) if isinstance(txt, list) else str(txt)
            self.finding(Finding("Ciclo politico", txt, "neutral", 50))

    async def on_message(self, msg):
        if msg["topic"] == "correlation.usdt":
            usdt_up = ((msg.get("data") or {}).get("change_7d") or 0) > 0.05
            if usdt_up and self.state.get("dxy_regime") == "bearish":
                await self.say("macro.riskoff", "Risk-off confermato: dollaro forte e USDT dominance in salita nello stesso momento.",
                               to="analyst", kind="alert", tone="bearish")
            elif not usdt_up and self.state.get("dxy_regime") == "bullish":
                await self.say("macro.riskon", "Risk-on confermato: dollaro debole e USDT dominance in calo.", to="analyst", tone="bullish")


class StructureAgent(MultiAgent):
    """Struttura: range e sweep sui timeframe alti, pivot di apertura (lunedì, settimana, mese) e piano di scenari condizionali."""

    PARTS = (("range", 60, "_c_range", "_a_range"), ("opening", 60, "_c_opening", "_a_opening"), ("scenarios", 120, "_c_scenarios", "_a_scenarios"))

    def _c_range(self):
        return {"r": _call("structure", "build_ranges")}

    def _c_opening(self):
        return {"p": _call("structure", "build_pivots")}

    def _c_scenarios(self):
        return {"sc": _call("structure", "build_scenarios")}

    async def _a_range(self, r):
        rg = r["r"]
        txt = rg.get("summary")
        if isinstance(txt, str) and txt:
            self.finding(Finding("Range e struttura", txt, "neutral", 65))
        tfs = rg.get("timeframes") or {}
        d1 = tfs.get("1d") if isinstance(tfs, dict) else None
        state = (d1 or {}).get("state") if isinstance(d1, dict) else None
        label = (d1 or {}).get("state_label") if isinstance(d1, dict) else None
        if state and state != self.state.get("prev_state"):
            if self.state.get("prev_state"):
                await self.say("structure.event", f"Cambio di stato del range giornaliero: {label or state}.", kind="alert",
                               tone="neutral", data={"state": state})
                self.refresh("scenarios")   # la struttura è cambiata: ricalcolo gli scenari
                self.trigger()
            self.state["prev_state"] = state
        if isinstance(txt, str) and txt:
            await self.say("structure.range", txt.split(". ")[0] + ".", data={"state": state})

    async def _a_opening(self, r):
        p = r["p"]
        mon = (p.get("monday") or {}).get("current") or {}
        if mon.get("high"):
            text = mon.get("text") or f"Range del lunedì {_k(mon.get('low'))}–{_k(mon.get('high'))}."
            self.finding(Finding("Range del lunedì", text, "neutral", 65))
            await self.say("opening.monday", text.split(". ")[0] + ".", data={"high": mon.get("high"), "low": mon.get("low")})
            broke = "high" if mon.get("broke_high") else "low" if mon.get("broke_low") else None
            if broke and self.state.get("broke") != broke:
                side = "massimo" if broke == "high" else "minimo"
                await self.say("opening.break", f"Rotto il {side} del lunedì ({_k(mon.get(broke))}): storicamente il prezzo rientra spesso nel range.",
                               kind="alert", tone="neutral")
                self.refresh("scenarios")
                self.trigger()
            self.state["broke"] = broke

    async def _a_scenarios(self, r):
        sc = r["sc"]
        items = sc.get("scenarios") or []
        if items:
            parts = []
            for it in items[:3]:
                trig = (it.get("trigger") or {}).get("text") or ""
                tgt = (it.get("targets") or [{}])[0]
                parts.append(f"{it.get('title')}: {trig.rstrip('.')} → {_k(tgt.get('price'))}")
            text = " | ".join(parts)
            self.finding(Finding("Piano scenari", text, "neutral", 60))
            await self.say("scenario.plan", f"{sc.get('state_label') or 'Scenari aggiornati'}. " + (items[0].get("title") or ""),
                           to="analyst", data={"n": len(items)})

    async def on_message(self, m):
        if m["topic"] == "market.price":
            self.refresh("opening")
            self.trigger()
        elif m["topic"].startswith(("liquidity.sweep", "timepivot.alert")):
            self.refresh("scenarios")
            self.trigger()


class PositioningAgent(MultiAgent):
    """Posizionamento: opzioni Deribit (max pain, put/call, skew, DVOL), holder STH/LTH e indice contrarian di sentiment."""

    PARTS = (("options", 120, "_c_options", "_a_options"), ("sentiment", 300, "_c_sentiment", "_a_sentiment"), ("holders", 1800, "_c_holders", "_a_holders"))

    def _c_options(self):
        return {"o": _call("positioning", "build_options")}

    def _c_holders(self):
        return {"h": _call("positioning", "build_holders")}

    def _c_sentiment(self):
        return {"s": _call("positioning", "build_sentiment")}

    async def _a_options(self, r):
        k = r["o"].get("kpi") or {}
        exps = r["o"].get("expiries") or []
        big = max((e for e in exps if e.get("notional_usd")), key=lambda e: e.get("notional_usd") or 0, default=None)
        text = (f"Opzioni: put/call (OI) {k.get('pc_oi', 0):.2f}, skew 30g {k.get('skew_30d', 0):+.1f} vol, DVOL {((r['o'].get('dvol') or {}).get('current') or 0):.0f}.")
        if big:
            text += (f" Scadenza principale {util_data(big.get('time') or big.get('expiry'))}: max pain {_k(big.get('max_pain'))} "
                     f"({_usd(big.get('notional_usd'))} di nozionale).")
        self.finding(Finding("Posizionamento opzioni", text, "neutral", 60))
        await self.say("options.state", text, data={"max_pain": big.get("max_pain") if big else None})
        if k.get("next_max_pain"):
            await self.ask("levels", "request.levels", f"Il max pain {_k(k['next_max_pain'])} coincide con un livello chiave?",
                           {"prices": [k["next_max_pain"]] + ([big["max_pain"]] if big and big.get("max_pain") else [])})

    async def _a_holders(self, r):
        k = r["h"].get("kpi") or {}
        if k.get("sth_realized_price"):
            above = k.get("regime") == "above"
            text = (f"Prezzo medio di carico degli holder recenti (STH) {_k(k['sth_realized_price'])}: prezzo {k.get('dist_sth', 0):+.1f}% "
                    f"({'sopra' if above else 'sotto'} da {k.get('regime_days')} giorni), STH-MVRV {k.get('sth_mvrv', 0):.2f}, "
                    f"LTH {_k(k.get('lth_realized_price'))}.")
            tone = "bullish" if above else "bearish"
            self.finding(Finding("Holder STH/LTH", text, tone, 65))
            await self.say("holders.state", text, tone=tone, data={"sth_cost": k["sth_realized_price"], "regime": k.get("regime")})
            prev = self.state.get("regime")
            if prev and prev != k.get("regime"):
                await self.say("holders.cross", f"Il prezzo è passato {'sopra' if above else 'sotto'} il costo medio degli holder recenti ({_k(k['sth_realized_price'])}).",
                               kind="alert", tone=tone)
            self.state["regime"] = k.get("regime")

    async def _a_sentiment(self, r):
        c = r["s"].get("current") or {}
        if c.get("value") is not None:
            v = c["value"]
            tone = "bullish" if v < 25 else "neutral"
            text = f"Indice contrarian {v:.0f}/100 ({str(c.get('zone', '')).lower()}), {c.get('change_7d', 0):+.0f} punti in 7 giorni."
            self.finding(Finding("Sentiment contrarian", text, tone, 55))
            await self.say("sentiment.state", text, tone=tone, data={"value": v})
            if v < 20 and (self.state.get("last") or 100) >= 20:
                await self.say("sentiment.extreme", "Paura estrema nel posizionamento: storicamente zona di opportunità contrarian.", kind="alert", tone="bullish")
            self.state["last"] = v


class SupplyDemandAgent(Agent):
    """Domanda e offerta: riserve/flussi degli exchange, flussi ETF spot e assorbimento dell'emissione, attenzione retail."""

    def compute(self):
        out = {}
        for k, fn in (("ex", "build_exchanges"), ("etf", "build_etf"), ("att", "build_attention")):
            try:
                out[k] = _call("supply_demand", fn)
            except Exception as e:  # noqa: BLE001
                log.warning("supply_demand/%s: %s", fn, e)
        if not out:
            raise RuntimeError("nessuna fonte domanda/offerta disponibile")
        return out

    async def act(self, r):
        k = (r.get("ex") or {}).get("kpi") or {}
        if k.get("reserve"):
            n30 = k.get("net_30d") or 0
            tone = "bullish" if n30 < 0 else "bearish" if n30 > 0 else "neutral"
            text = (f"Riserve sugli exchange {k['reserve'] / 1e6:.2f}M BTC ({k.get('reserve_pct', 0):.2f}% dell'offerta), "
                    f"flusso netto 30 giorni {n30:+,.0f} BTC (z {k.get('z_30d') or 0:+.1f}).")
            self.finding(Finding("Riserve exchange", text, tone, 55))
            await self.say("supply.exchanges", text, tone=tone, data={"reserve": k["reserve"], "net_30d": n30})
        e = r.get("etf") or {}
        ek = e.get("kpi") or {}
        if ek.get("last_usd") is not None:
            ratio = ek.get("ratio_30d")
            tone = "bullish" if (ek.get("d5_usd") or 0) > 0 else "bearish" if (ek.get("d5_usd") or 0) < 0 else "neutral"
            text = (f"ETF spot: ultimo giorno {_usd((ek['last_usd'] or 0) * 1e6)} (provvisorio), 5 sedute {_usd((ek.get('d5_usd') or 0) * 1e6)}; "
                    f"in 30 giorni hanno assorbito {ratio:.2f}× i BTC emessi dai miner." if ratio is not None else
                    f"ETF spot: ultimo giorno {_usd((ek['last_usd'] or 0) * 1e6)} (provvisorio), 5 sedute {_usd((ek.get('d5_usd') or 0) * 1e6)}.")
            self.finding(Finding("Flussi ETF spot", text, tone, 55))
            await self.say("supply.etf", text, tone=tone, data={"last_usd": ek["last_usd"], "ratio_30d": ratio})
            day = e.get("as_of")
            if day and day != self.state.get("etf_day") and abs(ek["last_usd"] or 0) >= 500:
                await self.say("supply.etf.big", f"Flusso ETF spot molto ampio: {_usd(ek['last_usd'] * 1e6)} in una seduta.",
                               kind="alert", tone="bullish" if ek["last_usd"] > 0 else "bearish")
            self.state["etf_day"] = day
        ak = (r.get("att") or {}).get("kpi") or {}
        if ak.get("avg_30d"):
            text = f"Attenzione retail (Wikipedia): media 30 giorni {ak['avg_30d']:,.0f} visite/giorno, {ak.get('percentile') or 0:.0f}° percentile storico."
            self.finding(Finding("Attenzione retail", text, "neutral", 45))
            await self.say("supply.attention", text, data={"avg_30d": ak["avg_30d"], "percentile": ak.get("percentile")})


class VerifierAgent(Agent):
    """Track record: confronta le previsioni degli agenti con la realtà e calcola l'affidabilità di ciascuno."""

    def compute(self):
        return {"t": _call("tracking", "build", mode="all")}

    async def act(self, r):
        t = r["t"]
        ov = t.get("overall") or {}
        if ov.get("n_resolved"):
            text = (f"Previsioni verificate: {ov['n_resolved']}, direzione corretta {ov.get('hit_rate', 0):.1f}% "
                    f"(ultimi 90 giorni {((ov.get('last90') or {}).get('hit_rate') or 0):.1f}%), Brier {ov.get('brier', 0):.3f}.")
            self.finding(Finding("Affidabilità complessiva", text, "neutral", 80))
            await self.say("verifier.summary", text, to="analyst", data={"hit_rate": ov.get("hit_rate")})
        w = t.get("weights") or {}
        if isinstance(w, dict) and w:
            best = max(w.items(), key=lambda kv: kv[1])
            worst = min(w.items(), key=lambda kv: kv[1])
            self.finding(Finding("Pesi di affidabilità", f"Fonte più affidabile: {best[0]} ({best[1]:.2f}); meno affidabile: {worst[0]} ({worst[1]:.2f}).",
                                 "neutral", 70))
            _REL["t"] = 0.0  # l'Analista ricarica i pesi aggiornati


class AlertsAgent(MultiAgent):
    """Avvisi: riassume le notifiche emesse e segue le regole personali dell'utente. Il motore vero è app/alerts.py."""

    PARTS = (("history", 30, "_c_history", "_a_history"), ("rules", 60, "_c_rules", "_a_rules"))

    def _c_history(self):
        from .. import alerts
        return {"h": alerts.history(limit=20), "st": alerts.status()}

    def _c_rules(self):
        from .. import alert_rules as ar
        return {"rules": [ar.public(r) for r in ar.list_rules()]}

    async def _a_history(self, r):
        items = [a for a in (r.get("h") or []) if not a.get("silent")]
        last_seen = self.state.get("last_seen", 0)
        new = [a for a in items if (a.get("id") or 0) > last_seen] if isinstance(last_seen, int) else items
        if items:
            self.state["last_seen"] = max(a.get("id") or 0 for a in items) if all(isinstance(a.get("id"), int) for a in items) else last_seen
            top = items[0]
            self.finding(Finding("Ultimo avviso", f"{top.get('title')}: {top.get('text')}", "neutral", 70))
        for a in new[:3]:
            await self.say("alerts.sent", f"Notifica inviata: {a.get('title')}.", data={"severity": a.get("severity")})

    async def _a_rules(self, r):
        rules = r.get("rules") or []
        active = [x for x in rules if x.get("status") == "active"]
        errors = [x for x in rules if x.get("status") == "error"]
        fired = [x for x in rules if x.get("last_fired")]
        last = max(fired, key=lambda x: x["last_fired"]) if fired else None
        if not rules:
            text = "Nessuna regola personale configurata."
        else:
            text = f"Regole personali: {len(active)} attive su {len(rules)}"
            text += f", {len(errors)} con errore" if errors else ""
            text += f"; ultima scattata: {last['name']}." if last else "; nessuna è ancora scattata."
        self.finding(Finding("Avvisi personali", text, "neutral", 40))
        await self.say("custom.state", text, data={"active": len(active), "total": len(rules), "errors": len(errors)})
        if last and last["last_fired"] != self.state.get("last_fired"):
            if self.state.get("last_fired") is not None:
                await self.say("custom.fired", f"Scattato l'avviso personale «{last['name']}».", kind="alert")
            self.state["last_fired"] = last["last_fired"]


VWAP_NAME = {"w": "settimanale", "m": "mensile", "q": "trimestrale", "y": "annuale"}
VWAP_TAG = {"w": "W", "m": "M", "q": "Q", "y": "Y"}
VWAP_LVL = {"vwap": "VWAP", "up1": "+1σ", "dn1": "−1σ"}


def _vwap_member(m: str) -> str:
    """'pw_up1' -> 'pW +1σ', 'm_vwap' -> 'M VWAP'."""
    per, lvl = m.rsplit("_", 1)
    tag = f"p{VWAP_TAG[per[1]]}" if per.startswith("p") else VWAP_TAG[per]
    return f"{tag} {VWAP_LVL[lvl]}"


class VwapAgent(Agent):
    """VWAP ancorati W/M/Q/Y (Kraken Futures PF_XBTUSD, candele 1m chiuse): posizione del prezzo, cross, livelli precedenti."""

    HYST = 0.05          # % oltre il VWAP per considerare il lato cambiato (evita i falsi cross quando il prezzo ci gira attorno)
    TOUCH = 0.10         # % di distanza per il "tocco" di un livello del periodo precedente
    CROSS_COOLDOWN = 1800
    TOUCH_COOLDOWN = 4 * 3600

    def compute(self):
        from ..analysis import vwap as vw
        a = vw.ensure("kraken", budget_s=200)
        try:  # seconda fonte per la verifica incrociata: bootstrap progressivo, poi solo l'ultimo minuto
            vw.ensure("binance", budget_s=40)
        except Exception as e:  # noqa: BLE001
            log.info("vwap binance: %s", e)
        if not a["ready"]:
            return {"ready": False, "progress": a["progress"], "s": None}
        return {"ready": True, "progress": 1.0, "s": vw.build("kraken", "fine"), "vp": vw.prev_week_profile("kraken")}

    async def loop(self, delay: float) -> None:
        """Gira 4 s dopo la chiusura di ogni minuto (le candele 1m chiuse sono già pubblicate dall'exchange)."""
        await asyncio.sleep(delay)
        while True:
            await self.run_once()
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=60 - time.time() % 60 + 4)
            except asyncio.TimeoutError:
                pass

    async def act(self, r):
        if not r.get("ready"):
            self.finding(Finding("VWAP in preparazione", f"Download dello storico 1m Kraken in corso ({r.get('progress', 0) * 100:.0f}%).", "neutral", 30))
            return
        s = r["s"]
        P, px = s["periods_data"] or {}, s["price"]
        now = time.time()
        sides: dict = self.state.setdefault("sides", {})
        last_cross: dict = self.state.setdefault("last_cross", {})
        parts, above, sig = [], 0, []
        for p in ("w", "m", "q", "y"):
            d = P.get(p) or {}
            if d.get("vwap") is None or d.get("dist_pct") is None:
                continue
            dist, z = d["dist_pct"], d.get("z")
            above += dist > 0
            zs = f", {z:+.1f}σ" if z is not None else ""
            parts.append(f"{'sopra' if dist > 0 else 'sotto'} il VWAP {VWAP_NAME[p]} ${d['vwap']:,.0f} ({dist:+.2f}%{zs})")
            sig.append((p, dist > 0, round((z or 0) * 2) / 2))
            # cross con isteresi
            new = "above" if dist > self.HYST else "below" if dist < -self.HYST else sides.get(p)
            old = sides.get(p)
            sides[p] = new
            if old and new and new != old and now - last_cross.get(p, 0) > self.CROSS_COOLDOWN:
                last_cross[p] = now
                up = new == "above"
                await self.say(f"vwap.cross.{p}", f"Il prezzo ha incrociato {'al rialzo' if up else 'al ribasso'} il VWAP {VWAP_NAME[p]} "
                               f"(${d['vwap']:,.0f}, ancorato al {util_data(d['anchor'])}).", kind="alert",
                               tone="bullish" if up else "bearish", data={"period": p, "vwap": d["vwap"], "price": px}, dedupe=False)
        if not parts:
            return
        tone = "bullish" if above >= 3 else "bearish" if above <= 1 else "neutral"
        text = "Prezzo " + "; ".join(parts) + "."
        self.finding(Finding("Posizione rispetto ai VWAP", text, tone, 80))
        if tuple(sig) != self.state.get("sig"):
            self.state["sig"] = tuple(sig)
            await self.say("vwap.position", text, tone=tone, data={p: {"vwap": (P.get(p) or {}).get("vwap"), "dist_pct": (P.get(p) or {}).get("dist_pct"),
                                                                     "z": (P.get(p) or {}).get("z")} for p in ("w", "m", "q", "y")})
        # tocchi dei livelli del periodo precedente (estesi nel periodo corrente)
        touched: dict = self.state.setdefault("touched", {})
        prev_txt = []
        for p in ("w", "m", "q", "y"):
            pv = (P.get(p) or {}).get("prev") or {}
            if pv.get("vwap"):
                prev_txt.append(f"p{VWAP_TAG[p]} ${pv['vwap']:,.0f}")
            for k in ("vwap", "up1", "dn1"):
                lvl = pv.get(k)
                if not lvl:
                    continue
                d = (px / lvl - 1) * 100
                key = f"p{p}_{k}"
                if abs(d) <= self.TOUCH and now - touched.get(key, 0) > self.TOUCH_COOLDOWN:
                    touched[key] = now
                    await self.say("vwap.touch", f"Prezzo sul livello p{VWAP_TAG[p]} {VWAP_LVL[k]} ${lvl:,.0f} del periodo precedente "
                                   f"({d:+.2f}%): livello esteso nel periodo corrente.", tone="neutral",
                                   data={"period": p, "level": k, "price": lvl}, dedupe=False)
        if prev_txt:
            self.finding(Finding("VWAP dei periodi precedenti", " · ".join(prev_txt) + ".", "neutral", 70))
        vp = r.get("vp")
        if vp:
            self.finding(Finding("Profilo volume settimana precedente",
                                 f"POC ${vp['poc']:,.0f} · value area 70% ${vp['val']:,.0f}–${vp['vah']:,.0f} (bin ${vp['bin']:,.0f}).", "neutral", 65))
            for k, nm in (("poc", "POC"), ("vah", "VAH"), ("val", "VAL")):
                d = (px / vp[k] - 1) * 100
                key = f"vp_pw_{k}"
                if abs(d) <= self.TOUCH and now - touched.get(key, 0) > self.TOUCH_COOLDOWN:
                    touched[key] = now
                    await self.say("vwap.touch", f"Prezzo sul {nm} del profilo di volume della settimana precedente ${vp[k]:,.0f} ({d:+.2f}%).",
                                   tone="neutral", data={"level": key, "price": vp[k]}, dedupe=False)
        cf = [c for c in (s.get("confluence") or []) if c.get("distance_pct") is not None and abs(c["distance_pct"]) <= 1.0]
        if cf:
            c = cf[0]
            names = ", ".join(_vwap_member(m) for m in c["members"])
            text = f"Confluenza di livelli VWAP a ${c['mid']:,.0f} ({c['distance_pct']:+.2f}% dal prezzo): {names}."
            self.finding(Finding("Confluenza VWAP", text, "neutral", 65))
            key = ",".join(c["members"])
            if key != self.state.get("cf_key"):   # al team solo quando cambia il gruppo di livelli
                self.state["cf_key"] = key
                await self.say("vwap.confluence", text, data={"mid": c["mid"], "members": c["members"]})


ANOM_TYPE_IT = {"funding": "funding Binance", "oi": "open interest Bybit", "liq_long": "liquidazioni long", "liq_short": "liquidazioni short",
                "volume": "volume spot", "etf": "flussi ETF spot", "exchange": "flussi netti degli exchange"}
ANOM_PHRASE_IT = {"funding_up": "funding Binance molto alto", "funding_dn": "funding Binance molto basso",
                  "oi_up": "open interest Bybit in forte aumento", "oi_dn": "open interest Bybit in forte calo",
                  "liq_long_up": "liquidazioni long eccezionali", "liq_short_up": "liquidazioni short eccezionali", "volume_up": "volume spot eccezionale",
                  "etf_up": "afflussi eccezionali negli ETF spot", "etf_dn": "deflussi eccezionali dagli ETF spot",
                  "exchange_up": "afflussi netti eccezionali verso gli exchange", "exchange_dn": "deflussi netti eccezionali dagli exchange"}
ANOM_VERDICT_IT = {"strong": "differenza significativa anche dopo la correzione per test multipli",
                   "weak": "differenza che non regge alla correzione per test multipli",
                   "none": "nessuna differenza distinguibile dal caso", "anecdotal": "casi troppo pochi per un giudizio"}


def _art_it(d: str) -> str:
    from ..util import art
    return art(d, "il")


def _anom_value(ev: dict) -> str:
    v, u = ev.get("value") or 0, ev.get("unit")
    if u == "pct_8h":
        return f"{v:+.4f}%/8h"
    if u == "musd":
        return f"{v:+,.0f}M$"
    if u == "usd":
        return _usd(v)
    if ev.get("type") == "oi":
        return f"{ev.get('x') or 0:+.1f}% in un giorno"
    return f"{v:+,.0f} BTC" if ev.get("type") == "exchange" else f"{v:,.0f} BTC"


class AnomalyAgent(Agent):
    """Anomalie: z robusto point-in-time su funding, OI, liquidazioni, volume, flussi ETF ed exchange; annuncia le nuove
    con il backtest storico del loro tipo (descrittivo: nessun segnale)."""

    def compute(self):
        return {"a": _call("superchart", "build_anomalies")}

    async def act(self, r):
        a = r["a"]
        rows = {x["id"]: x for x in a.get("types") or []}
        recent = sorted(a.get("recent") or [], key=lambda e: e["time"])
        seen: set = self.state.setdefault("seen", set())
        first = not self.state.get("init")
        now = _now()
        for ev in recent:
            key = f"{ev['id']}:{ev['time']}"
            if key in seen:
                continue
            seen.add(key)
            if first and ev.get("avail", 0) < now - 2 * 86400:
                continue                      # primo giro: solo le anomalie appena pubblicate, niente arretrati
            row = rows.get(ev["id"]) or {}
            h7 = next((c for c in row.get("horizons") or [] if c.get("h") == 7), None)
            msg = f"Anomalia: {ANOM_PHRASE_IT.get(ev['id'], ev['id'])} {_art_it(util_data(ev['time']))} ({_anom_value(ev)}, z {ev['z']:+.1f})."
            if h7 and h7.get("n"):
                rt, vo = h7["ret"], h7["vol"]
                msg += (f" Su {h7['n']} casi storici dello stesso tipo, BTC a 7 giorni ha fatto in media {rt['mean']:+.1f}% "
                        f"contro {rt['base']:+.1f}% di un giorno qualsiasi ({ANOM_VERDICT_IT.get(rt['verdict'], rt['verdict'])}); "
                        f"movimento assoluto medio {vo['mean']:.1f}% contro {vo['base']:.1f}% ({ANOM_VERDICT_IT.get(vo['verdict'], vo['verdict'])}).")
            else:
                msg += " Storico insufficiente per un backtest di questo tipo."
            await self.say(f"anomalies.{ev['type']}", msg, data={"id": ev["id"], "time": ev["time"], "z": ev["z"], "verdict": row.get("verdict")})
        self.state["init"] = True
        sig = [ANOM_TYPE_IT.get(x["type"], x["type"]) + (" (+)" if x["sign"] > 0 else " (−)") for x in rows.values() if x.get("verdict") == "strong"]
        p = a.get("params") or {}
        text = (f"{len(recent)} anomalie negli ultimi {p.get('recent_days', 30)} giorni (|z| ≥ {p.get('thr', 3):g}, finestra {p.get('window', 90)} giorni). "
                + (f"Tipi con un effetto storico significativo dopo la correzione: {', '.join(sig)}." if sig
                   else "Nessun tipo mostra un effetto storico significativo dopo la correzione per test multipli."))
        self.finding(Finding("Anomalie recenti", text, "neutral", 55))
        if recent:
            ev = recent[-1]
            self.finding(Finding("Ultima anomalia", f"{(lambda x: x[:1].upper() + x[1:])(ANOM_PHRASE_IT.get(ev['id'], ev['id']))} {_art_it(util_data(ev['time']))} (z {ev['z']:+.1f}).", "neutral", 50))


class OrderFlowAgent(MultiAgent):
    """Order flow in tempo reale, solo descrizione (nessun segnale operativo): il book Binance perpetual e i trade di sette mercati.

    Book (app/ob_collector.py), soglie dichiarate: muro = bucket da $10 ≥ k × mediana dei bucket entro ±1% (k = 5, min 2 BTC, ≥ 20 s);
    ritiro prima del tocco = muro sceso sotto il 30% del massimo con prezzo entro 0,15% e senza scambi a quel livello; squilibrio
    persistente = quota bid entro ±0,5% media > 60% (o < 40%) con > 80% dei campioni dello stesso lato negli ultimi 15 min;
    divergenza = prezzo ±0,2% in un'ora con CVD di segno opposto e ≥ 10% del volume. Tono sempre neutrale: la liquidità visibile non
    rivela intenzioni.

    Trade (app/terminal_collector.py: Binance, Bybit, OKX perp e spot + Coinbase): divergenza tra CVD spot e perp aggregati nell'ultima
    ora (segni opposti, |delta| ≥ 5% del volume spot e ≥ 3% del perp), squilibrio persistente degli acquisti/vendite aggressivi (ultimi
    15 minuti: quota acquisti ≥ 58% o ≤ 42% con ≥ 73% dei minuti dallo stesso lato), grandi trade (≥ $1M negli ultimi 5 minuti) e
    raffiche di liquidazioni reali (≥ $5M di un lato in 5 minuti).
    """

    PARTS = (("book", 30, "_c_book", "_a_book"), ("trades", 60, "_c_trades", "_a_trades"), ("moves", 300, "_c_moves", "_a_moves"))

    def _c_book(self):
        return {"sig": _call("orderbook", "build_signals", market="futures")}

    def _c_trades(self):
        return {"tsig": _call("terminal", "build_signals")}

    def _c_moves(self):
        return {"mv": _call("scoreboard", "recent_moves")}

    async def _a_moves(self, r):
        """Ultimo movimento forte: cronaca descrittiva. Un movimento finito da meno di 2 ore diventa un avviso informativo, una volta sola."""
        from ..analysis import moves
        ev = r["mv"].get("events") or []
        if not ev:
            return
        e = ev[0]
        text = moves.describe_it(e)
        self.finding(Finding("Dopo il movimento", text, "neutral", 55))
        if e["id"] != self.state.get("move_said") and time.time() - e["to"] <= 7200:
            self.state["move_said"] = e["id"]
            await self.say("flow.move", text, kind="alert", data={"id": e["id"], "ret_pct": e["ret_pct"], "tags": e["tags"]})

    async def _a_book(self, r):
        s = r["sig"]
        if not s.get("synced") or not s.get("mid"):
            self.finding(Finding("Stato del book", "Book Binance perpetual in sincronizzazione: nessuna lettura finché snapshot e diff stream non sono allineati.", "neutral", 40))
            return
        rule = s.get("wall_rule") or {}
        walls = s.get("walls") or []
        bid = min((w for w in walls if w["side"] == "bid"), key=lambda w: abs(w["dist_pct"]), default=None)
        ask = min((w for w in walls if w["side"] == "ask"), key=lambda w: abs(w["dist_pct"]), default=None)
        thr = rule.get("threshold")
        if bid or ask:
            parts = []
            if bid:
                parts.append(f"bid a ${bid['price']:,.0f} ({bid['q']:.0f} BTC, {bid['dist_pct']:+.2f}%)")
            if ask:
                parts.append(f"ask a ${ask['price']:,.0f} ({ask['q']:.0f} BTC, {ask['dist_pct']:+.2f}%)")
            text = (f"Muri di liquidità più vicini entro ±1%: {' e '.join(parts)}. Soglia: {rule.get('k', 5):g}× la mediana dei livelli "
                    f"(ora {thr or 0:.0f} BTC per bucket da $10). Liquidità visibile, può essere spostata in ogni momento.")
            self.finding(Finding("Muri di liquidità", text, "neutral", 55))
            key = (bid and bid["price"], ask and ask["price"])
            # i muri vicini cambiano spesso: al team al massimo ogni 15 minuti (il finding resta sempre aggiornato)
            if self.state.get("walls_key") != key and time.time() - self.state.get("walls_said", 0) >= 900:
                self.state["walls_key"] = key
                self.state["walls_said"] = time.time()
                await self.say("orderbook.walls", text, data={"bid": bid, "ask": ask, "threshold": thr})
        else:
            self.finding(Finding("Muri di liquidità", f"Nessun livello entro ±1% supera la soglia ({rule.get('k', 5):g}× la mediana, ora {thr or 0:.0f} BTC).", "neutral", 50))
        # liquidità ritirata prima del tocco: riassunto 30 min + annuncio dei ritiri grandi (≥ 2× soglia) appena avvenuti
        evs = s.get("events") or []
        pulled = [e for e in evs if e["kind"] == "pulled"]
        consumed = [e for e in evs if e["kind"] == "consumed"]
        self.finding(Finding("Muri spariti (30 min)", f"{len(pulled)} ritirati prima del tocco e {len(consumed)} consumati dagli scambi vicino al prezzo. "
                             "Un ritiro è un fatto osservabile, non un'accusa: gli ordini vengono spostati per molti motivi.", "neutral", 50))
        last_t = self.state.get("pulled_t", time.time() - 300)
        big = [e for e in pulled if e["t"] > last_t and thr and e["qmax"] >= 2 * thr]
        if big and time.time() - self.state.get("pulled_said", 0) >= 300:
            e = max(big, key=lambda x: x["qmax"])
            self.state["pulled_t"] = max(x["t"] for x in big)
            self.state["pulled_said"] = time.time()
            await self.say("orderbook.pulled", f"Liquidità ritirata prima del tocco: muro {e['side']} da {e['qmax']:.0f} BTC a ${e['price']:,.0f} sceso a "
                           f"{e['q']:.0f} BTC con il prezzo a {e['dist_pct']:.2f}% e quasi nessuno scambio a quel livello (durata {e['age_s']} s).",
                           data={"price": e["price"], "side": e["side"], "qmax": e["qmax"]})
        # squilibrio bid/ask persistente
        im = s.get("imbalance")
        if im:
            side = im.get("persistent")
            text = (f"Quota bid entro ±0.5% dal mid: {im['mean'] * 100:.1f}% in media negli ultimi {im['minutes']:.0f} min (ora {im['now'] * 100:.1f}%)"
                    + (f"; squilibrio persistente lato {'bid' if side == 'bid' else 'ask'}." if side else "; nessuno squilibrio persistente."))
            self.finding(Finding("Squilibrio bid/ask", text, "neutral", 50))
            if side and self.state.get("imb_side") != side:
                await self.say("orderbook.imbalance", text, data={"side": side, "mean": im["mean"]})
            self.state["imb_side"] = side
        # delta / CVD dell'ultima ora vs prezzo
        cv = s.get("cvd")
        if cv:
            div = cv.get("divergence")
            text = (f"Ultima ora: prezzo {cv['price_change_pct']:+.2f}%, CVD {cv['cvd']:+.0f} BTC su {cv['volume']:.0f} BTC scambiati in modo aggressivo"
                    + ("; il prezzo sale mentre prevalgono le vendite aggressive (divergenza)." if div == "price_up_cvd_down" else
                       "; il prezzo scende mentre prevalgono gli acquisti aggressivi (divergenza)." if div == "price_down_cvd_up" else "."))
            self.finding(Finding("Delta e CVD", text, "neutral", 50))
            if div and self.state.get("div") != div:
                await self.say("orderbook.cvd", text, data={"divergence": div, "cvd": cv["cvd"], "price_change_pct": cv["price_change_pct"]})
                await self._flow_context(cv["cvd"])
            self.state["div"] = div

    async def _a_trades(self, r):
        s = r["tsig"]
        if not s.get("streams_live"):
            self.finding(Finding("Stato della raccolta", "Nessuno stream di trade connesso: order flow aggregato non disponibile.", "neutral", 30))
            return
        now = time.time()
        cv = s.get("cvd")
        if cv:
            div = cv.get("divergence")
            text = (f"Ultima ora ({cv['minutes']} min raccolti): CVD spot aggregato {cv['spot']:+,.0f} BTC ({cv['spot_share'] * 100:+.1f}% del volume spot), "
                    f"CVD perp aggregato {cv['perp']:+,.0f} BTC ({cv['perp_share'] * 100:+.1f}% del volume perp), prezzo {cv['price_change_pct']:+.2f}%"
                    + ("; lo spot compra in modo aggressivo mentre i perpetual vendono (divergenza)." if div == "spot_buy_perp_sell" else
                       "; lo spot vende in modo aggressivo mentre i perpetual comprano (divergenza)." if div == "spot_sell_perp_buy" else "."))
            self.finding(Finding("CVD spot vs perp", text, "neutral", 55))
            if div and self.state.get("tdiv") != div:
                await self.say("flow.divergence", text, data={"divergence": div, "spot": cv["spot"], "perp": cv["perp"]})
            self.state["tdiv"] = div
        else:
            self.finding(Finding("CVD spot vs perp", "Servono almeno 30 minuti di trade raccolti da tutti gli exchange per confrontare CVD spot e perp.", "neutral", 30))
        im = s.get("imbalance")
        if im:
            side = im.get("persistent")
            text = (f"Ultimi {im['minutes']} minuti: acquisti aggressivi {im['buy_share'] * 100:.1f}% del controvalore scambiato su 7 mercati, "
                    f"{im['minutes_buy']} minuti su {im['minutes']} a prevalenza acquisti, delta {_usd(im['delta_usd'])}"
                    + (f"; squilibrio persistente lato {'acquisti' if side == 'buy' else 'vendite'}." if side else "; nessuno squilibrio persistente."))
            self.finding(Finding("Squilibrio dell'order flow", text, "neutral", 50))
            if side and self.state.get("imb") != side:
                await self.say("flow.imbalance", text, data={"side": side, "buy_share": im["buy_share"]})
            self.state["imb"] = side
        lg = s.get("large") or {}
        if lg.get("n"):
            mx = lg.get("max") or {}
            ex = STREAM_IT.get(mx.get("s") or "", mx.get("s") or "")
            text = (f"{lg['n']} trade da almeno {_usd(lg['threshold'])} negli ultimi 5 minuti per {_usd(lg['usd'])} "
                    f"({_usd(lg['buy_usd'])} in acquisto); il più grande {_usd(mx.get('u'))} su {ex} a ${(mx.get('p') or 0):,.0f}.")
            self.finding(Finding("Grandi trade", text, "neutral", 50))
            if now - self.state.get("large_said", 0) >= 300:
                self.state["large_said"] = now
                await self.say("flow.large", text, data={"n": lg["n"], "usd": lg["usd"]})
        else:
            self.finding(Finding("Grandi trade", f"Nessun trade da almeno {_usd(lg.get('threshold'))} negli ultimi 5 minuti.", "neutral", 40))
        lq = s.get("liq5") or {}
        if lq.get("burst") and now - self.state.get("liq_said", 0) >= 300:
            side = lq["burst"]
            text = (f"Raffica di liquidazioni reali {side} negli ultimi 5 minuti: long {_usd(lq['long_usd'])}, short {_usd(lq['short_usd'])} "
                    f"({lq['n']} eventi su Binance, Bybit e OKX).")
            self.finding(Finding("Liquidazioni recenti", text, "neutral", 60))
            self.state["liq_said"] = now
            await self.say("flow.liquidations", text, data={"side": side, "long_usd": lq["long_usd"], "short_usd": lq["short_usd"]})
        elif lq:
            self.finding(Finding("Liquidazioni recenti", f"Ultimi 5 minuti: long {_usd(lq.get('long_usd'))}, short {_usd(lq.get('short_usd'))} ({lq.get('n', 0)} eventi).", "neutral", 45))

    async def _flow_context(self, cvd: float) -> None:
        """Divergenza delta/CVD sul solo perpetual Binance: aggiunge il contesto aggregato degli altri exchange (se disponibile)."""
        cv = (self.state.get("tsig") or {}).get("cvd")
        if not cv:
            return
        same = "conferma" if (cv["perp"] > 0) == (cvd > 0) else "non conferma"
        await self.say("flow.context", f"Contesto multi-exchange: il CVD perp aggregato di Binance, Bybit e OKX nell'ultima ora è {cv['perp']:+,.0f} BTC e "
                       f"{same} la lettura del solo Binance; CVD spot aggregato {cv['spot']:+,.0f} BTC.", data={"perp": cv["perp"], "spot": cv["spot"]})


STREAM_IT = {"binance_perp": "Binance perp", "bybit_perp": "Bybit perp", "okx_perp": "OKX perp", "binance_spot": "Binance spot",
             "coinbase_spot": "Coinbase", "bybit_spot": "Bybit spot", "okx_spot": "OKX spot"}


SIGNAL_SETUP_IT = {"vwap_reclaim": "riconquista del VWAP", "vwap_reject": "rifiuto del VWAP", "band_revert": "ritorno alla media sulle bande VWAP", "sweep": "sweep di liquidità",
                   "bos_retest": "rottura di struttura con retest", "cvd_div": "divergenza del delta spot e perp", "funding_ext": "estremo di funding", "donchian": "rottura del canale"}
SIGNAL_EVENT_IT = {"active": "entrata eseguita", "tp1": "TP1 raggiunto", "tp2": "TP2 raggiunto", "sl": "stop raggiunto", "be": "stop a pareggio dopo TP1", "timeout": "chiuso a scadenza",
                   "invalidated": "invalidato", "expired": "scaduto senza entrata", "canceled": "annullato"}


class SignalsAgent(MultiAgent):
    """Segnali seguiti sulla carta: valuta i setup a ogni chiusura di candela e controlla entrata, stop e target dei segnali aperti.
    I segnali sperimentali restano neutrali per l'Analista: un setup non validato non pesa nel consenso del team."""

    PARTS = (("tick", 15, "_tick", "_on_tick"), ("prep", 600, "_prep", "_on_prep"))

    def _tick(self):
        from .. import signals as sg
        return {"signals": sg.tick()}

    def _prep(self):
        from .. import signals as sg
        sg.ensure_ready()
        return {}

    async def _on_prep(self, _r):
        pass

    @staticmethod
    def _tone(s: dict) -> Tone:
        if s.get("tier") != "validated":
            return "neutral"
        return "bullish" if s.get("side") == "long" else "bearish"

    async def _on_tick(self, r):
        from .. import alerts
        from .. import signals as sg
        written = [e for e in r["signals"]["written"] if e["type"] not in ("leave", "comment")]
        if not written:
            return
        sigs = sg.fold()
        for e in written:
            s = sigs.get(e["sig"])
            if not s:
                continue
            tag = "sperimentale" if s["tier"] == "experimental" else "validato"
            head = f"{s['side'].capitalize()} {s['tf']} ({tag})"
            if e["type"] == "emitted":
                name = SIGNAL_SETUP_IT.get(s["setup"], s["setup"])
                text = f"{head}: {name}. Entry ${s['entry']:,.0f}, stop ${s['sl']:,.0f}, TP1 ${s['tp1']:,.0f}, TP2 ${s['tp2']:,.0f}. Segnale statistico seguito sulla carta."
                self.finding(Finding(f"Segnale {s['family']} {s['side']}", text, self._tone(s), 50))
                await self.say("signals.new", text, tone=self._tone(s), data={"id": s["id"]})
                await alerts.emit(f"signal:{s['id']}:emitted", 0, alerts._alert("warning" if s["tier"] == "validated" else "info", "signals", f"Nuovo segnale {head}", text, "/segnali", {"id": s["id"]}, "signal_new"))
                sg.comment_async(s["id"])
            else:
                res = f" Esito {e['data']['r']:+.2f}R." if (e.get("data") or {}).get("r") is not None else ""
                text = f"{head}: {SIGNAL_EVENT_IT.get(e['type'], e['type'])}" + (f" a ${e['price']:,.0f}." if e.get("price") else ".") + res
                await self.say("signals.update", text, data={"id": s["id"], "type": e["type"]})
                await alerts.emit(f"signal:{s['id']}:{e['type']}", 0, alerts._alert("info", "signals", f"Segnale {head}: {SIGNAL_EVENT_IT.get(e['type'], e['type'])}", text, "/segnali", {"id": s["id"], "rebuilt": bool(e.get("rebuilt"))}, "signal_update"))
        await _ws_push({"type": "invalidate", "source": self.id, "keys": ["/signals"], "time": _now()})


class ForecastAgent(Agent):
    def compute(self):
        return {"f": _call("forecast", "get_forecast", horizon=90)}

    async def act(self, r):
        ts = {t["days"]: t for t in r["f"].get("targets", [])}
        t30 = ts.get(30)
        if t30:
            up = t30["up_prob"] * 100 if t30["up_prob"] <= 1 else t30["up_prob"]
            tone = "bullish" if up > 55 else "bearish" if up < 45 else "neutral"
            text = f"Previsione 30g: mediana {_k(t30['median'])}, range {_k(t30['low'])}–{_k(t30['high'])}, probabilità rialzo {up:.0f}%."
            self.finding(Finding("Previsione 30 giorni", text, tone, 55))
            await self.say("forecast.targets", text, tone=tone, data={"median_30": t30["median"], "up_prob": up})
            self.state["tone30"] = tone

    async def on_message(self, m):
        if m["topic"].startswith("pattern.projection.d1") and self.state.get("tone30"):
            agree = m.get("tone") == self.state["tone30"]
            await self.say("forecast.check", "Modello ML e frattale 1D concordano." if agree else "Modello ML e frattale 1D sono in disaccordo: scenario incerto.",
                           to="analyst", tone=self.state["tone30"] if agree else "neutral")


class AnalystAgent(Agent):
    """Orchestratore: raccoglie i finding di tutti, calcola il consenso e (se c'è LM Studio) scrive la sintesi."""

    def compute(self):
        sb = _optional("scoreboard", "build")
        views = []
        for a in bus.agents.values():
            if a.id == self.id:
                continue
            for f in list(a.findings)[:a.views]:
                views.append({"agent": a.name, "id": a.id, **f})
        rel = _reliability()
        for v in views:
            v["w"] = v["confidence"] * (0.5 + rel.get(v.get("src") or v["id"], 0.5))
        score = sum((1 if v["tone"] == "bullish" else -1 if v["tone"] == "bearish" else 0) * v["w"] for v in views)
        weight = sum(v["w"] for v in views) or 1
        consensus = score / weight * 100
        summary = None
        try:
            from .. import llm
            if llm.available() and views:
                lines = "\n".join(f"- [{v['agent']}] {v['text']}" for v in views[:20])
                from ..routers import ai as ai_router
                summary = llm.complete([
                    {"role": "system", "content": "Sei l'analista capo di un team di agenti che studiano Bitcoin. Rispondi in italiano, "
                     "massimo 3 frasi, tono professionale, nessun consiglio finanziario personale. Usa SOLO i numeri presenti nei report. "
                     "Un cluster di liquidazioni SOTTO il prezzo attira il prezzo verso il basso (non è un supporto); uno SOPRA lo attira "
                     "verso l'alto. Non contraddire la fase di ciclo dell'agente Cicli e non annunciare un nuovo minimo se è indicato un minimo già segnato."},
                    {"role": "user", "content": f"Sintetizza il quadro attuale dai report degli agenti (consenso {consensus:+.0f}/100):\n{lines}"},
                ], max_tokens=600, temperature=0.3)
                known = ai_router._snapshot_numbers([v["text"] for v in views] + [consensus], [])
                if summary and not ai_router._semantic_ok({"text": summary}, {}):
                    summary = None
                if summary and not ai_router._verified(summary, known):
                    log.info("sintesi dell'analista scartata dalla verifica numerica")
                    summary = None
        except Exception as e:  # noqa: BLE001
            log.info("analyst senza LLM: %s", e)
        return {"consensus": consensus, "summary": summary, "n": len(views), "sb": sb}

    async def act(self, r):
        sb = r.get("sb")
        if sb:
            # il tabellone conta punti: resta neutrale per non pesare due volte nel consenso del team
            self.finding(Finding("Tabellone Bull vs Bear", f"{sb['bull']} punti rialzisti, {sb['bear']} ribassisti da regole dichiarate. È un conteggio, non una previsione.", "neutral", 60))
        c = r["consensus"]
        tone = "bullish" if c > 15 else "bearish" if c < -15 else "neutral"
        label = {"bullish": "rialzista", "bearish": "ribassista", "neutral": "neutrale"}[tone]
        text = r["summary"] or f"Consenso del team {label} ({c:+.0f}/100) su {r['n']} segnali degli agenti."
        self.finding(Finding("Sintesi del team", text, tone, min(95, 50 + abs(c) / 2)))
        await self.say("analyst.summary", text, tone=tone, data={"consensus": c})

    async def on_message(self, m):
        if m["kind"] == "alert":
            self.state["last_alert"] = m
        n = self.state.get("pending", 0) + 1
        self.state["pending"] = n
        if n >= 8:  # tanti aggiornamenti: anticipo la sintesi
            self.state["pending"] = 0
            self.trigger()


def build_team() -> list[Agent]:
    return [
        AnalystAgent("analyst", "Analista AI", 120, subscribes=[
            "liquidity.", "levels.confluence", "levels.touch", "market.alert", "pattern.", "correlation.", "cycle.", "clock.", "miners.", "leverage.",
            "onchain.", "derivatives.signal", "flows.", "flow.", "orderbook.", "analogs.", "usdt_analogs.", "timepivot.", "macro.", "events.",
            "stablecoins.", "structure.", "opening.", "scenario.", "verifier.", "options.", "holders.", "sentiment.", "forecast.", "vwap.", "anomalies.", "signals."]),
        MarketAgent("market", "Market Data", 5),
        LevelsAgent("levels", "Pivot & Livelli", 30, subscribes=["market.price", "request.levels"]),
        VwapAgent("vwap", "VWAP ancorati", 60),
        LiquidityAgent("liquidity", "Liquidazioni", 30, subscribes=["market.price", "derivatives.oi", "request.liquidity"]),
        AnalogsAgent("analogs", "Analoghi", 60, subscribes=["correlation."], views=6),
        UsdtAgent("usdt", "USDT e stablecoin", 60, views=4),
        CycleAgent("cycles", "Cicli", 300, subscribes=["flows.spike"], views=8),
        OnchainAgent("onchain", "On-Chain", 300),
        DerivativesAgent("derivatives", "Derivati", 20, views=8),
        FlowsAgent("flows", "Flussi Spot/Futures", 30, subscribes=["derivatives.funding"]),
        SupplyDemandAgent("supply_demand", "Domanda e offerta", 1800),
        TimePivotsAgent("timepivots", "Pivot temporali", 600, subscribes=["cycle.phase"]),
        MacroAgent("macro", "Macro ed eventi", 300, subscribes=["correlation.usdt"], views=4),
        StructureAgent("structure", "Struttura", 60, subscribes=["market.price", "liquidity.sweep", "timepivot.alert"], views=6),
        PositioningAgent("positioning", "Posizionamento", 120, views=6),
        AnomalyAgent("anomalies", "Anomalie", 1800),
        OrderFlowAgent("orderflow", "Order flow", 30, views=4),
        ForecastAgent("forecast", "Previsioni ML", 600, subscribes=["pattern.projection.d1"]),
        SignalsAgent("signals", "Segnali", 15),
        VerifierAgent("verifier", "Verifica", 1800),
        AlertsAgent("alerts", "Avvisi", 30, views=4),
    ]


_started = False


async def start() -> None:
    global _started
    if _started:
        return
    _started = True
    team = build_team()
    for a in team:
        bus.agents[a.id] = a
    # avvio scaglionato: prima i produttori di dati, l'analista per ultimo
    order = {"market": 1, "derivatives": 3, "vwap": 4, "levels": 5, "flows": 6, "liquidity": 8, "usdt": 11, "alerts": 12, "cycles": 14,
             "orderflow": 15, "onchain": 17, "analogs": 20, "signals": 22, "forecast": 25, "timepivots": 30, "macro": 33, "structure": 46, "anomalies": 50,
             "positioning": 56, "supply_demand": 64, "analyst": 66, "verifier": 70}
    loop = asyncio.get_running_loop()
    for a in team:
        loop.create_task(a.inbox_loop())
        loop.create_task(a.loop(order.get(a.id, 5)))
    log.info("%d agenti avviati", len(team))


def status() -> dict:
    """Riassunto per l'indicatore di stato della barra laterale."""
    agents = list(bus.agents.values())
    return {"total": len(agents), "errors": [{"id": a.id, "name": a.name, "error": a.error} for a in agents if a.status == "error"]}
