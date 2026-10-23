"""Team di agenti autonomi.

Ogni agente possiede un dominio (liquidazioni, livelli, pattern, ...), gira con il proprio intervallo,
pubblica "finding" sul bus e reagisce ai messaggi degli altri (richieste, conferme, allerte).
Tutti i messaggi sono salvati in un ring buffer e inoltrati in tempo reale sul WebSocket /api/ws.
"""
from __future__ import annotations

import asyncio
import importlib
import itertools
import json
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
        self.edges: dict[tuple[str, str], dict] = {}

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
        sender.sent += 1
        targets = [self.agents[to]] if to != "*" and to in self.agents else [a for a in self.subscribers(topic) if a.id != sender.id]
        for t in targets:
            e = self.edges.setdefault((sender.id, t.id), {"topics": set(), "count": 0, "last": None})
            e["topics"].add(topic)
            e["count"] += 1
            e["last"] = msg["time"]
        await _ws_push({"type": "agent_message", **msg})
        for t in targets:
            t.received += 1
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

    def as_dict(self) -> dict:
        return {"title": self.title, "text": self.text, "tone": self.tone, "confidence": round(self.confidence), "time": _now()}


@dataclass
class Agent:
    id: str
    name: str
    role: str
    icon: str
    color: str
    interval_s: int
    subscribes: list[str] = field(default_factory=list)
    publishes: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.status = "idle"
        self.error: str | None = None
        self.runs = 0
        self.last_run: int | None = None
        self.next_run: int | None = None
        self.last_duration_ms: int | None = None
        self.findings: deque[dict] = deque(maxlen=6)
        self.sent = 0
        self.received = 0
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.state: dict[str, Any] = {}
        self._last_text: dict[str, str] = {}
        self._wake = asyncio.Event()

    # -- helpers
    def finding(self, f: Finding) -> None:
        if not self.findings or self.findings[0]["text"] != f.text:
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
        await self._push_status()
        t = time.perf_counter()
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
        self.runs += 1
        self.last_run = _now()
        self.last_duration_ms = int((time.perf_counter() - t) * 1000)
        self.next_run = self.last_run + self.interval_s
        await self._push_status()
        if self.status != "error":
            keys = INVALIDATES.get(self.id)
            if keys:  # i dati del modulo sono stati ricalcolati: il browser ricarica subito quelle query
                await _ws_push({"type": "invalidate", "source": self.id, "keys": keys, "time": self.last_run})

    async def _push_status(self) -> None:
        await _ws_push({"type": "agent_status", "id": self.id, "status": self.status, "last_run": self.last_run,
                        "next_run": self.next_run, "last_duration_ms": self.last_duration_ms})

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

    def to_dict(self) -> dict:
        return clean({
            "id": self.id, "name": self.name, "role": self.role, "icon": self.icon, "color": self.color,
            "status": self.status, "error": self.error, "interval_s": self.interval_s, "runs": self.runs,
            "last_run": self.last_run, "next_run": self.next_run, "last_duration_ms": self.last_duration_ms,
            "findings": list(self.findings), "subscribes": self.subscribes, "publishes": self.publishes,
            "stats": {"messages_sent": self.sent, "messages_received": self.received},
        })


# agente -> prefissi delle API i cui dati cambiano quando l'agente ricalcola (per l'aggiornamento live del frontend)
INVALIDATES: dict[str, list[str]] = {
    "market": ["/overview"],
    "levels": ["/levels", "/indicators"],
    "liquidity": ["/liquidations"],
    "patterns": ["/fractals"],
    "correlation": ["/usdt"],
    "cycles": ["/cycles"],
    "onchain": ["/onchain"],
    "derivatives": ["/derivatives"],
    "flows": ["/flows"],
    "analogs": ["/analogs"],
    "timepivots": ["/timepivots"],
    "macro": ["/macro"],
    "clock": ["/cycle/advanced"],
    "miners": ["/cycle/advanced"],
    "leverage": ["/cycle/advanced"],
    "usdt_analogs": ["/usdt/analogs"],
    "stablecoins": ["/stablecoins"],
    "forecast": ["/forecast"],
    "range": ["/structure"],
    "opening": ["/structure"],
    "scenarios": ["/structure"],
    "events": ["/events"],
    "astro": ["/astro"],
    "verifier": ["/tracking"],
    "alerts": ["/alerts"],
    "options": ["/positioning"],
    "holders": ["/positioning"],
    "sentiment": ["/positioning"],
    "supply_demand": ["/supply-demand"],
    "custom_alerts": ["/alerts/rules"],
    "journal": ["/journal"],
    "basis": ["/derivatives/basis"],
    "cme": ["/derivatives/cme"],
    "agg_leverage": ["/derivatives/aggregate"],
    "analyst": ["/insights", "/agents"],
    "vwap": ["/vwap"],
    "timing": ["/timing"],
    "elliott": ["/elliott"],
    "anomalies": ["/anomalies", "/superchart/series"],
    "orderbook": ["/orderbook/status", "/orderbook/signals"],
    "flow": ["/terminal/status", "/terminal/signals"],
    "kronos": ["/forecast/kronos"],
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
        return {"liq": _call("liquidations", "build", range="7d")}

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


class PatternAgent(Agent):
    def compute(self):
        return {"h4": _call("fractals", "build", tf="4h", window=60, horizon=30, top=5),
                "d1": _call("fractals", "build", tf="1d", window=60, horizon=30, top=5)}

    async def act(self, r):
        for key, label in (("h4", "4H"), ("d1", "1D")):
            f = r[key]
            pj = f.get("projection") or {}
            best = (f.get("matches") or [{}])[0]
            up = pj.get("up_prob")
            if up is None:
                continue
            tone = pj.get("bias", "neutral")
            p50 = (pj.get("p50") or [None])[-1]
            text = (f"Frattale {label}: miglior analogo {best.get('label')} (similarità {best.get('similarity', 0):.0f}%). "
                    f"Probabilità rialzo {up * 100 if up <= 1 else up:.0f}%, mediana a fine orizzonte {_k(p50)}.")
            self.finding(Finding(f"Frattale {label}", text, tone, min(90, best.get("similarity", 50))))
            await self.say(f"pattern.projection.{key}", text, tone=tone, data={"tf": label, "up_prob": up, "p50": p50})
        rt = r["h4"].get("retests") or []
        if rt:
            prices = [x["price"] for x in rt[:4]]
            await self.say("pattern.retest", f"Gli analoghi indicano retest di: {', '.join(_k(p) for p in prices)}. Verifico con i livelli.",
                           data={"prices": prices})
            await self.ask("levels", "request.levels", "Questi prezzi di retest sono livelli chiave?", {"prices": prices})

    async def on_message(self, m):
        if m["topic"].startswith("correlation.usdt"):
            usdt_tone = m.get("tone")
            h4 = (self.state.get("h4") or {}).get("projection") or {}
            if usdt_tone and h4.get("bias") and usdt_tone != "neutral":
                agree = usdt_tone == h4["bias"]
                txt = ("USDT.D conferma il bias del frattale 4H." if agree else "USDT.D diverge dal frattale 4H: segnale meno affidabile.")
                await self.say("pattern.confirmation", txt, to="analyst", tone=h4["bias"] if agree else "neutral")


class CorrelationAgent(Agent):
    def compute(self):
        return {"usdt": _call("usdt", "build")}

    async def act(self, r):
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
                           tone="bullish" if mm["btc_outcome"] > 0 else "bearish", to="patterns", data=mm)

    async def on_message(self, m):
        pass


class CycleAgent(Agent):
    def compute(self):
        return {"c": _call("cycles", "build")}

    async def act(self, r):
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


class DerivativesAgent(Agent):
    def compute(self):
        return {"d": _call("derivatives", "build")}

    async def act(self, r):
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



class FlowsAgent(Agent):
    """Pressione di acquisto/vendita aggressiva: spot vs futures perpetual."""

    def compute(self):
        return {"fl": _call("flows", "build", tf="1h", range="7d")}

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


class AnalogsAgent(Agent):
    """Analogie storiche soprattutto grafiche (forma, candele, gambe, figure) su 4H e 1D."""

    def compute(self):
        out = {"h4": _call("analogs", "build", tf="4h", top=5), "d1": _call("analogs", "build", tf="1d", top=5)}
        try:  # analogia di struttura (sequenza di massimi/minimi ZigZag) su BTC e USDT.D giornalieri
            out["struct"] = {a: _call("struct_analogs", "build", asset=a, tf="1d") for a in ("btc", "usdtd")}
        except Exception as e:  # noqa: BLE001
            log.warning("analogia di struttura non disponibile: %s", e)
        return out

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

    async def act(self, r):
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

    async def on_message(self, m):
        topic = m["topic"]
        for key in ("h4", "d1"):
            if topic == f"pattern.projection.{key}" and self.state.get(f"bias_{key}"):
                mine, other = self.state[f"bias_{key}"], m.get("tone")
                if mine == "neutral" or other == "neutral":
                    continue
                label = "4H" if key == "h4" else "1D"
                txt = (f"Analoghi grafici e frattali {label} concordano ({'rialzo' if mine == 'bullish' else 'ribasso'})." if mine == other
                       else f"Analoghi grafici e frattali {label} sono discordi: segnale {label} meno affidabile.")
                await self.say(f"analogs.check.{key}", txt, to="analyst", tone=mine if mine == other else "neutral")


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


class MacroAgent(Agent):
    """Contesto macro (dollaro, tassi, volatilità, liquidità) e rotazione BTC/altcoin."""

    def compute(self):
        return {"m": _call("macro", "build")}

    async def act(self, r):
        m = r["m"]
        sm = m.get("summary") or {}
        if sm.get("score") is not None:
            neg = [c["label"] for c in sm.get("components", []) if c.get("tone") == "bearish"]
            pos = [c["label"] for c in sm.get("components", []) if c.get("tone") == "bullish"]
            text = (f"Contesto macro {sm['score']:.0f}/100 ({sm.get('label', '').lower()})."
                    + (f" A favore: {', '.join(pos)}." if pos else "") + (f" Contro: {', '.join(neg)}." if neg else ""))
            self.finding(Finding("Contesto macro", text, sm.get("tone", "neutral"), 60))
            await self.say("macro.context", text, tone=sm.get("tone", "neutral"), data={"score": sm["score"]})
        dxy = ((m.get("kpi") or {}).get("dxy") or {})
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

    async def on_message(self, msg):
        if msg["topic"] == "correlation.usdt":
            usdt_up = ((msg.get("data") or {}).get("change_7d") or 0) > 0.05
            if usdt_up and self.state.get("dxy_regime") == "bearish":
                await self.say("macro.riskoff", "Risk-off confermato: dollaro forte e USDT dominance in salita nello stesso momento.",
                               to="analyst", kind="alert", tone="bearish")
            elif not usdt_up and self.state.get("dxy_regime") == "bullish":
                await self.say("macro.riskon", "Risk-on confermato: dollaro debole e USDT dominance in calo.", to="analyst", tone="bullish")


class CycleClockAgent(Agent):
    """Orologio del ciclo (score 0-100) e confronto 'stesso giorno del ciclo'."""

    def compute(self):
        return {"a": _call("cycle_advanced", "build")}

    async def act(self, r):
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

    async def on_message(self, m):
        if m["topic"] == "cycle.phase":
            z = self.state.get("zone")
            ph = (m.get("data") or {}).get("phase")
            if z and ph:
                ok = ((ph == "accumulation" and z in ("bottom", "accumulation", "mid"))
                      or (ph in ("bull", "distribution") and z in ("mid", "euphoria", "top")))
                await self.say("clock.check", ("Orologio del ciclo coerente con la fase stimata dall'agente Cicli." if ok
                                               else "Orologio del ciclo e fase stimata non concordano: lettura del ciclo incerta."),
                               to="analyst", tone="neutral")


class MinerAgent(Agent):
    """Ciclo dei miner: Hash Ribbons, Difficulty Ribbon, Puell."""

    def compute(self):
        return {"mi": _call("cycle_advanced", "build")["miner"]}

    async def act(self, r):
        mi = r["mi"]
        tone = "bullish" if mi.get("state") == "recovery" else "bearish" if mi.get("state") == "capitulation" else "neutral"
        text = (f"Hash Ribbons: {mi.get('label', '').lower()} da {mi.get('days_in_state')} giorni; hashrate {mi.get('hr_drawdown') or 0:+.0f}% dal massimo, "
                f"compressione Difficulty Ribbon {mi.get('ribbon_compression') or 0:.1f}%, Puell {mi.get('puell') or 0:.2f}.")
        self.finding(Finding("Ciclo dei miner", text, tone, 60))
        await self.say("miners.state", text, tone=tone, data={"state": mi.get("state")})
        if self.state.get("prev") and self.state["prev"] != mi.get("state"):
            await self.say("miners.signal", f"Cambio di stato dei miner: ora {mi.get('label', '').lower()}.", kind="alert", tone=tone)
        self.state["prev"] = mi.get("state")


class LeverageAgent(Agent):
    """Ciclo della leva: funding e speculazione rispetto alla fase di ciclo."""

    def compute(self):
        return {"lv": _call("cycle_advanced", "build")["leverage"]}

    async def act(self, r):
        lv = r["lv"]
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
            self.trigger()


class UsdtAnalogsAgent(Agent):
    """Analoghi grafici della USDT dominance e cosa ha fatto BTC dopo."""

    def compute(self):
        return {"u": _call("usdt_analogs", "build", tf="1d")}

    async def act(self, r):
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
        if m["topic"] == "correlation.usdt":
            self.trigger()  # nuova lettura di dominance: ricalcolo gli analoghi


class StablecoinsAgent(Agent):
    """Liquidità stablecoin: supply totale, emissione, dominance, SSR."""

    def compute(self):
        return {"s": _call("usdt_analogs", "build_stablecoins")}

    async def act(self, r):
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


class RangeAgent(Agent):
    """Range sui timeframe alti, sweep, accettazioni, rientri e struttura di mercato."""

    def compute(self):
        return {"r": _call("structure", "build_ranges")}

    async def act(self, r):
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
            self.state["prev_state"] = state
        if isinstance(txt, str) and txt:
            await self.say("structure.range", txt.split(". ")[0] + ".", data={"state": state})


class OpeningPivotAgent(Agent):
    """Pivot di apertura: massimo/minimo del lunedì, aperture settimanali/mensili, chiusure settimanali."""

    def compute(self):
        return {"p": _call("structure", "build_pivots")}

    async def act(self, r):
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
            self.state["broke"] = broke

    async def on_message(self, m):
        if m["topic"] == "market.price":
            self.trigger()


class ScenarioAgent(Agent):
    """Piano scenari condizionali: combina struttura, livelli, liquidità, analoghi e pivot temporali."""

    def compute(self):
        return {"sc": _call("structure", "build_scenarios")}

    async def act(self, r):
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
        if m["topic"].startswith(("structure.event", "opening.break", "liquidity.sweep", "timepivot.alert")):
            self.trigger()  # la struttura è cambiata: ricalcolo gli scenari


class EventsAgent(Agent):
    """Calendario macro e politico (FOMC, CPI, lavoro, scadenze, midterm) con la reazione storica di BTC."""

    def compute(self):
        return {"e": _call("events", "build", horizon=60)}

    async def act(self, r):
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


ASTRO_EVENT_IT = {
    "full": "Luna piena", "new": "Luna nuova", "supermoon": "Superluna", "lunar_eclipse_total": "Eclissi lunare totale (luna rossa)",
    "lunar_eclipse": "Eclissi lunare", "solar_eclipse": "Eclissi solare", "mercury_retro_start": "Inizio di Mercurio retrogrado",
    "mercury_retro_end": "Fine di Mercurio retrogrado", "mar_equinox": "Equinozio di marzo", "jun_solstice": "Solstizio di giugno",
    "sep_equinox": "Equinozio di settembre", "dec_solstice": "Solstizio di dicembre", "friday13": "Venerdì 13",
    "geomag_storm": "Tempesta geomagnetica prevista (Kp ≥ 5)",
}
ASTRO_VERDICT_IT = {"none": "nessun effetto distinguibile dal caso", "weak": "effetto debole (non regge alla correzione per test multipli o è instabile nel tempo)",
                    "strong": "effetto significativo e stabile", "anecdotal": "troppo pochi casi per giudicare (aneddotico)"}


class AstroAgent(Agent):
    """Astronomia e numeri: annuncia gli eventi astronomici imminenti insieme al verdetto statistico storico (studio, non segnale)."""

    def compute(self):
        return {"a": _call("astro", "build", horizon=30)}

    async def act(self, r):
        a = r["a"]
        now = _now()
        hyps = a.get("hypotheses") or []
        sig = [h for h in hyps if h.get("verdict") == "strong"]
        text = (f"Studio astronomia e numeri: {len(hyps)} ipotesi testate sullo storico di BTC contro il caso (placebo e correzione Benjamini-Hochberg); "
                + (f"{len(sig)} con effetto significativo e stabile." if sig else "nessuna mostra un effetto significativo e stabile."))
        self.finding(Finding("Verdetti dello studio", text, "neutral", 70))
        await self.say("astro.summary", text, data={"significant": [h["id"] for h in sig]})
        soon = [u for u in (a.get("upcoming") or []) if 0 <= (u.get("time", 0) - now) <= 3 * 86400]
        for u in soon[:3]:
            label = ASTRO_EVENT_IT.get(u.get("key"), u.get("key"))
            days = max(0, round((u["time"] - now) / 86400))
            when = "oggi" if days == 0 else "domani" if days == 1 else f"tra {days} giorni"
            v = u.get("verdict") or "none"
            msg = f"{label} {when} ({util_data(u['time'])}): storicamente {ASTRO_VERDICT_IT.get(v, v)} (n={u.get('n')}"
            msg += f", p corretto {u['p_bh']:.2f})." if isinstance(u.get("p_bh"), (int, float)) else ")."
            if v == "strong" and isinstance(u.get("effect"), (int, float)):
                msg += f" Scarto medio rispetto al normale {u['effect']:+.2f}{'%' if u.get('unit') == '%' else ' pp'}."
            await self.say("astro.soon", msg, data={"id": u.get("id"), "verdict": v})
        if soon:
            u = soon[0]
            self.finding(Finding("Prossimo evento astronomico", f"{ASTRO_EVENT_IT.get(u.get('key'), u.get('key'))} il {util_data(u['time'])}: "
                                 f"{ASTRO_VERDICT_IT.get(u.get('verdict') or 'none')}.", "neutral", 50))


TIMING_TYPE_IT = {"c30": "30 giorni", "c45": "45 giorni", "c60": "60 giorni", "c90": "90 giorni", "c120": "120 giorni", "c144": "144 giorni",
                  "c180": "180 giorni", "c270": "270 giorni", "c360": "360 giorni", "c_mult": "multipli lunghi", "sq9": "quadrato del 9",
                  "yeardiv": "divisione dell'anno", "anniv": "anniversario", "seasonal": "data stagionale"}
TIMING_EVENT_IT = {"PS": "PS", "SC": "SC (selling climax)", "AR_A": "AR", "ST_A": "ST", "SPRING": "Spring", "TEST": "test dello Spring",
                   "SOS": "SOS (sign of strength)", "LPS": "LPS", "BRK_DN": "rottura al ribasso", "PSY": "PSY", "BC": "BC (buying climax)",
                   "AR_D": "AR", "ST_D": "ST", "UT": "UT", "UTAD": "UTAD", "SOW": "SOW (sign of weakness)", "LPSY": "LPSY", "BRK_UP": "rottura al rialzo"}
TIMING_SIDE_IT = {"acc": "accumulazione", "dist": "distribuzione"}


def _art_it(d: str) -> str:
    from ..util import art
    return art(d, "il")
TIMING_VERDICT_IT = {"none": "nessun vantaggio rispetto al caso", "weak": "effetto debole (non regge alla correzione per test multipli)",
                     "strong": "effetto significativo e stabile", "anecdotal": "casi troppo pochi per un giudizio"}


class TimingAgent(Agent):
    """Timing Gann · Wyckoff · ritmi: date chiave imminenti con il loro track record, eventi e fasi di Wyckoff, ritmi solo se significativi."""

    def finding(self, f: Finding) -> None:
        """Una sola voce per titolo (i numeri cambiano a ogni giro: si aggiorna la voce invece di accodarne di nuove)."""
        for i, x in enumerate(list(self.findings)):
            if x["title"] == f.title:
                del self.findings[i]
                break
        self.findings.appendleft(f.as_dict())

    def compute(self):
        out = {"o": _call("timing", "build_overview")}
        rh = {}
        for kind in ("weekday", "hour"):
            try:
                rh[kind] = _call("timing", "build_rhythms", kind=kind)
            except Exception as e:  # noqa: BLE001
                log.info("timing ritmi %s: %s", kind, e)
        out["rh"] = rh
        return out

    async def act(self, r):
        o = r["o"]
        g = o.get("gann") or {}
        v = g.get("verdicts") or {}
        n_types = sum(v.values())
        summary = (f"Conteggi di Gann verificati su {n_types} tipi (pivot a 10 giorni entro ±2 g, dal 2012): "
                   + (f"{v.get('strong', 0)} con effetto significativo e stabile, " if v.get("strong") else "nessuno con effetto significativo e stabile, ")
                   + f"{v.get('weak', 0)} deboli.")
        self.finding(Finding("Verdetto dei conteggi di Gann", summary, "neutral", 70))
        # ---- data chiave entro 3 giorni
        nxt = g.get("next")
        win = (g.get("params") or {}).get("win", 2)
        for u in (g.get("upcoming") or []):
            if 0 <= u["days_away"] <= 3 and u["score"] >= 2:
                types = ", ".join(TIMING_TYPE_IT.get(x, x) for x in u["types"])
                when = "oggi" if u["days_away"] == 0 else "domani" if u["days_away"] == 1 else f"tra {u['days_away']} giorni"
                hr, br = u.get("hist_hit_rate"), u.get("hist_base_rate")
                msg = f"Data chiave Gann {when} ({util_data(u['time'])}, finestra ±{win} g): {u['score']} conteggi in confluenza ({types}). "
                if hr is not None and br is not None:
                    msg += (f"Storicamente le date con questo punteggio hanno avuto un pivot a 10 giorni nella finestra nel {hr:.0f}% dei casi "
                            f"contro il {br:.0f}% di un giorno qualsiasi: {TIMING_VERDICT_IT.get(u.get('hist_verdict') or 'none', TIMING_VERDICT_IT['none'])}.")
                await self.say("timing.key_date", msg, data={"time": u["time"], "score": u["score"], "verdict": u.get("hist_verdict")})
                break
        if nxt:
            self.finding(Finding("Prossima data chiave", f"{util_data(nxt['time'])}: punteggio {nxt['score']} ({', '.join(TIMING_TYPE_IT.get(x, x) for x in nxt['types'])}); "
                                 f"hit rate storico {nxt.get('hist_hit_rate') or 0:.0f}% contro {nxt.get('hist_base_rate') or 0:.0f}% per caso.", "neutral", 50))
        # ---- Wyckoff: cambi di fase ed eventi nuovi
        for tf, w in (o.get("wyckoff") or {}).items():
            a = w.get("active")
            tfl = "1D" if tf == "1d" else "4H"
            if not a:
                key = (tf, None, None, None)
                if self.state.get(f"wy_{tf}") not in (None, key):
                    lc = w.get("last_closed") or {}
                    await self.say(f"timing.wyckoff.{tf}", f"Wyckoff {tfl}: il range di {TIMING_SIDE_IT.get(lc.get('side'), '')} si è chiuso "
                                   f"({'rottura nella direzione attesa' if lc.get('status') in ('up', 'down') else 'range fallito o scaduto'}); nessun range attivo.")
                self.state[f"wy_{tf}"] = key
                continue
            le = a.get("last_event") or {}
            key = (tf, a["side"], a["phase"], (le.get("key"), le.get("time")))
            if self.state.get(f"wy_{tf}") != key:
                msg = (f"Wyckoff {tfl}: {TIMING_SIDE_IT[a['side']]} in fase {a['phase']} (range ${a['low']:,.0f}–${a['high']:,.0f}); "
                       f"ultimo evento {TIMING_EVENT_IT.get(le.get('key'), le.get('key'))} {_art_it(util_data(le.get('time')))} a ${le.get('price') or 0:,.0f}.")
                st = w.get("stat")
                if st and st.get("n") and st.get("mean") is not None:
                    msg += (f" Dopo un {TIMING_EVENT_IT.get(st['key'], st['key'])} {tfl} BTC ha fatto in media {st['mean']:+.1f}% a 10 giorni "
                            f"(n={st['n']}, {TIMING_VERDICT_IT.get(st.get('verdict') or 'none')}).")
                await self.say(f"timing.wyckoff.{tf}", msg, data={"side": a["side"], "phase": a["phase"], "event": le.get("key")})
                self.state[f"wy_{tf}"] = key
                self.finding(Finding(f"Wyckoff {tfl}", msg, "neutral", 50))
        # ---- ritmi: solo se significativi dopo la correzione
        sig = []
        for kind, res in (r.get("rh") or {}).items():
            for row in res.get("rows") or []:
                if row.get("verdict") == "strong":
                    sig.append((kind, row))
        if sig:
            kind, row = sig[0]
            lab = (["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"][row["bucket"]] if kind == "weekday"
                   else f"le {row['bucket']:02d}:00 UTC")
            await self.say("timing.rhythm", f"Ritmo di calendario significativo dopo la correzione per test multipli: {lab} "
                           f"(rendimento medio {row['mean']:+.3f}%, {row['diff']:+.3f} punti rispetto alle altre caselle, p corretto {row['p_bh']:.3f}, stabile negli anni).",
                           data={"kind": kind, "bucket": row["bucket"]})
        rc = (o.get("rhythm") or {}).get("close") or {}
        full = rc.get("full") or {}
        if full.get("n"):
            self.finding(Finding("Pump inizio · dump metà · pump fine", f"Mese in tre parti (chiusure, dal 2017): lo schema appare nel {full.get('rate') or 0:.1f}% dei mesi "
                                 f"contro il {full.get('null') or 0:.1f}% atteso per caso; {TIMING_VERDICT_IT.get(rc.get('verdict') or 'none')}.", "neutral", 60))


EW_PATTERN_IT = {"impulse": "impulso", "diagonal": "diagonale", "zigzag": "zigzag", "flat": "flat", "triangle": "triangolo",
                 "double_zigzag": "doppio zigzag", "double_three": "doppia three"}
EW_VARIANT_IT = {"expanded": "espanso", "regular": "regolare", "running": "running", "contracting": "contraente", "expanding": "espansivo",
                 "barrier": "a barriera", "contracting_leading": "contraente iniziale", "contracting_ending": "contraente finale",
                 "expanding_leading": "espansiva iniziale", "expanding_ending": "espansiva finale"}
EW_DEGREE_IT = {"cycle": "Cycle", "primary": "Primary", "intermediate": "Intermediate", "minor": "Minor", "minute": "Minute"}
EW_VERDICT_IT = {"none": "nessun vantaggio predittivo sulle baseline", "weak": "vantaggio debole", "strong": "vantaggio significativo e stabile",
                 "anecdotal": "casi troppo pochi per un giudizio"}
EW_RANK_IT = {"none": "non migliore del caso", "weak": "debolmente migliore del caso", "strong": "migliore del caso in modo significativo",
              "anecdotal": "casi troppo pochi"}


def _ew_wave_it(w: str | None) -> str:
    if w in (None, "next"):
        return "prima onda del movimento successivo"
    if w == "next2":
        return "onda successiva"
    if w == "thrust":
        return "spinta dopo il triangolo"
    return f"onda {w}"


def _ew_name(c: dict) -> str:
    v = EW_VARIANT_IT.get(c.get("variant") or "", "")
    return (EW_PATTERN_IT.get(c["pattern"], c["pattern"]) + (f" {v}" if v else "")
            + (" al rialzo" if c["direction"] == "up" else " al ribasso"))


class ElliottAgent(Agent):
    """Onde di Elliott: conteggio preferito per 4H/1D/1W con invalidazione, obiettivi e verdetto del backtest. Solo descrizione."""

    def finding(self, f: Finding) -> None:
        for i, x in enumerate(list(self.findings)):
            if x["title"] == f.title:
                del self.findings[i]
                break
        self.findings.appendleft(f.as_dict())

    def compute(self):
        return {"o": _call("elliott", "build_overview")}

    async def act(self, r):
        price = live_price()
        for tf in ("1d", "4h", "1w"):
            d = (r.get("o") or {}).get(tf) or {}
            cs = d.get("counts") or []
            if not cs:
                continue
            c = cs[0]
            tfl = {"4h": "4H", "1d": "1D", "1w": "1W"}[tf]
            deg = EW_DEGREE_IT.get(d.get("degree"), d.get("degree"))
            inv = c.get("invalidation") or {}
            inv_txt = " e ".join(x for x in (
                f"sotto ${inv['below']:,.0f}" if inv.get("below") else "", f"sopra ${inv['above']:,.0f}" if inv.get("above") else "") if x)
            pj = (c.get("projection") or [{}])[0]
            tgt = (f"obiettivo dell'{_ew_wave_it(c['wave'])} ${pj['lo']:,.0f}–${pj['hi']:,.0f} (centro ${pj['price']:,.0f})"
                   if pj.get("price") else "obiettivo non stimabile")
            prob = c.get("prob")
            bt = d.get("backtest") or {}
            ptxt = (f"in passato il conteggio di rango 1 è stato quello giusto a posteriori nel {prob['p']:.0f}% dei casi (n={prob['n']})"
                    if prob else f"punteggio delle linee guida {c['score']:.0f}/100 (probabilità non calibrabile)")
            text = (f"Elliott {tfl} (grado {deg}): conteggio preferito {_ew_name(c)}, in corso {_ew_wave_it(c['wave'])}{' di Y' if c['pattern'].startswith('double') and c['wave'] in ('a', 'b', 'c') else ''}; "
                    f"{tgt}; invalidazione {inv_txt or 'n/d'}. Alternativi validi: {d.get('n_valid', 0) - 1}; {ptxt}. "
                    f"Backtest: {EW_VERDICT_IT.get(bt.get('verdict'), 'n/d')}, ordinamento dei conteggi {EW_RANK_IT.get(bt.get('rank_verdict'), 'n/d')}. "
                    "Descrizione di studio, non un segnale.")
            self.finding(Finding(f"Elliott {tfl}", text, "neutral", 40))
            key = f"{tf}:{c['id']}:{c['wave']}"
            prev = self.state.get(f"ew_{tf}")
            data = {"tf": tf, "degree": d.get("degree"), "pattern": c["pattern"], "variant": c.get("variant"), "wave": c["wave"],
                    "direction": c["direction"], "invalid_below": inv.get("below"), "invalid_above": inv.get("above"),
                    "target": pj.get("price"), "target_lo": pj.get("lo"), "target_hi": pj.get("hi"), "verdict": bt.get("verdict"),
                    "rank_verdict": bt.get("rank_verdict"), "prob": prob["p"] if prob else None}
            if prev != key:
                pre = "Cambio di conteggio. " if prev else ""
                await self.say(f"elliott.count.{tf}", pre + text, data=data)
                self.state[f"ew_{tf}"] = key
            # prezzo live oltre l'invalidazione del preferito: il conteggio va rivisto alla prossima chiusura
            if price:
                broken = (inv.get("below") and price < inv["below"]) or (inv.get("above") and price > inv["above"])
                bkey = f"{key}:broken"
                if broken and self.state.get(f"ew_b_{tf}") != bkey:
                    lvl = inv["below"] if inv.get("below") and price < inv["below"] else inv["above"]
                    await self.say(f"elliott.invalidated.{tf}", f"Elliott {tfl}: il prezzo (${price:,.0f}) ha superato l'invalidazione del conteggio preferito "
                                   f"({_ew_name(c)}, ${lvl:,.0f}): il conteggio verrà ricalcolato alla chiusura della candela.", data=data)
                    self.state[f"ew_b_{tf}"] = bkey


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


class AlertsAgent(Agent):
    """Motore delle notifiche: segue gli avvisi emessi (soglie, cooldown, anti-spam) e li riassume al team."""

    def compute(self):
        from .. import alerts
        return {"h": alerts.history(limit=20), "st": alerts.status()}

    async def act(self, r):
        items = [a for a in (r.get("h") or []) if not a.get("silent")]
        last_seen = self.state.get("last_seen", 0)
        new = [a for a in items if (a.get("id") or 0) > last_seen] if isinstance(last_seen, int) else items
        if items:
            self.state["last_seen"] = max(a.get("id") or 0 for a in items) if all(isinstance(a.get("id"), int) for a in items) else last_seen
            top = items[0]
            self.finding(Finding("Ultimo avviso", f"{top.get('title')}: {top.get('text')}", "neutral", 70))
        for a in new[:3]:
            await self.say("alerts.sent", f"Notifica inviata: {a.get('title')}.", data={"severity": a.get("severity")})


class OptionsAgent(Agent):
    """Opzioni Deribit: max pain per scadenza, put/call, skew, DVOL, muri di gamma."""

    def compute(self):
        return {"o": _call("positioning", "build_options")}

    async def act(self, r):
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


class HoldersAgent(Agent):
    """Holder a breve e lungo termine: prezzo medio di carico, MVRV, SOPR."""

    def compute(self):
        return {"h": _call("positioning", "build_holders")}

    async def act(self, r):
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


class SentimentAgent(Agent):
    """Sentiment contrarian: indice composito paura/euforia con backtest."""

    def compute(self):
        return {"s": _call("positioning", "build_sentiment")}

    async def act(self, r):
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


class ImagePatternAgent(Agent):
    """Ricerca da immagine: quando l'utente carica uno screenshot, riporta al team i pattern storici trovati."""

    def compute(self):
        from ..routers import image_pattern as ipr
        return {"last": dict(ipr.LAST)}

    async def act(self, r):
        last = r.get("last") or {}
        if not last.get("n") or last["n"] == self.state.get("seen"):
            return
        self.state["seen"] = last["n"]
        res = last.get("res") or {}
        ms = res.get("matches") or []
        if not ms:
            return
        m = ms[0]
        tf = m.get("tf") or ""
        period = (m.get("period") or {}).get("label") or ""
        o = m.get("outcome") or {}
        label = period if f"({tf}" in period or not tf else f"{period} ({tf})"
        text = (f"Pattern da immagine: miglior corrispondenza {label}, somiglianza {m.get('similarity') or 0:.0f}%; "
                f"dopo {o.get('candles')} candele BTC {o.get('change') or 0:+.1f}%.")
        self.finding(Finding("Ricerca da immagine", text, "neutral", min(85, m.get("similarity") or 50)))
        await self.say("image.match", text, data={"tf": tf, "period": period})
        await self.say("image.match", text, to="analogs", kind="finding")


class CustomAlertsAgent(Agent):
    """Avvisi personali: tiene d'occhio le regole dell'utente e segnala al team quelle vicine alla soglia o scattate."""

    def compute(self):
        from .. import alert_rules as ar
        return {"rules": [ar.public(r) for r in ar.list_rules()]}

    async def act(self, r):
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


class JournalAgent(Agent):
    """Diario: verifica le viste dell'utente alla scadenza e riporta l'hit rate al team."""

    def compute(self):
        from .. import journal as jr
        return jr.reviews()

    async def act(self, r):
        st = r.get("stats") or {}
        tot, pend = st.get("total") or 0, st.get("pending") or 0
        if tot:
            text = f"Diario: {tot} viste verificate, hit rate {st.get('hit_rate') or 0:.0f}%; {pend} in attesa di scadenza."
        elif pend:
            text = f"Diario: {pend} viste in attesa di scadenza, nessuna ancora verificata."
        else:
            text = "Diario: nessuna vista con direzione e orizzonte da verificare."
        tone = "neutral"
        self.finding(Finding("Diario di studio", text, tone, 40))
        await self.say("journal.state", text, data={"total": tot, "pending": pend, "hit_rate": st.get("hit_rate")})
        if tot != self.state.get("total"):
            if self.state.get("total") is not None and tot > self.state["total"]:
                it = (r.get("items") or [{}])[0]
                rv = it.get("review") or {}
                await self.say("journal.review", f"Verificata la vista «{it.get('title') or 'senza titolo'}»: "
                               f"{'centrata' if rv.get('hit') else 'mancata'} ({rv.get('change_pct') or 0:+.1f}%).", kind="alert")
            self.state["total"] = tot


class DerivSignalsAgent(Agent):
    """Derivati pro (basis, CME COT, leva aggregata): riporta al team i segnali verificati del proprio modulo."""

    BUILDERS = {"basis": ("build_basis", "Basis e curva futures"), "cme": ("build_cme", "CME COT"),
                "agg_leverage": ("build_aggregate", "Leva aggregata")}

    def compute(self):
        fn, _ = self.BUILDERS[self.id]
        return _call("derivatives", fn)

    async def act(self, r):
        _, title = self.BUILDERS[self.id]
        sig = [x for x in (r.get("signals") or []) if x.get("text")]
        if not sig:
            return
        tones = [x.get("tone") for x in sig[:3]]
        tone = "bullish" if tones.count("bullish") > tones.count("bearish") else "bearish" if tones.count("bearish") > tones.count("bullish") else "neutral"
        text = " ".join(x["text"] for x in sig[:2])
        self.finding(Finding(title, text, tone, 55))
        await self.say(f"{self.id}.state", text, tone=tone)
        await self.say(f"{self.id}.state", text, to="derivatives", tone=tone)


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

    def finding(self, f: Finding) -> None:
        """Una sola voce per titolo (i numeri cambiano ogni minuto: si aggiorna la voce invece di accodarne di nuove)."""
        for i, x in enumerate(list(self.findings)):
            if x["title"] == f.title:
                del self.findings[i]
                break
        self.findings.appendleft(f.as_dict())

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


class OrderBookAgent(Agent):
    """Order book Binance USDⓈ-M BTCUSDT (collector app/ob_collector.py): descrive muri, ritiri, squilibri e divergenze delta/CVD.

    Soglie dichiarate: muro = bucket da $10 ≥ k × mediana dei bucket entro ±1% (k = 5, min 2 BTC, ≥ 20 s); ritiro prima del tocco =
    muro sceso sotto il 30% del massimo con prezzo entro 0,15% e senza scambi a quel livello; squilibrio persistente = quota bid
    entro ±0,5% media > 60% (o < 40%) con > 80% dei campioni dello stesso lato negli ultimi 15 min; divergenza = prezzo ±0,2% in
    un'ora con CVD di segno opposto e ≥ 10% del volume. Tono sempre neutrale: la liquidità visibile non rivela intenzioni.
    """

    def finding(self, f: Finding) -> None:
        for i, x in enumerate(list(self.findings)):
            if x["title"] == f.title:
                del self.findings[i]
                break
        self.findings.appendleft(f.as_dict())

    def compute(self):
        return {"sig": _call("orderbook", "build_signals", market="futures")}

    async def act(self, r):
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
            self.state["div"] = div


class TerminalFlowAgent(Agent):
    """Order flow multi-exchange del Terminale (app/terminal_collector.py: trade di Binance, Bybit, OKX perp e spot + Coinbase).

    Descrive, senza segnali: divergenza tra CVD spot e CVD perp aggregati nell'ultima ora (segni opposti, |delta| ≥ 5% del volume
    spot e ≥ 3% del perp), squilibrio persistente degli acquisti/vendite aggressivi (ultimi 15 minuti: quota acquisti ≥ 58% o
    ≤ 42% con ≥ 73% dei minuti dallo stesso lato), grandi trade (≥ $1M negli ultimi 5 minuti) e raffiche di liquidazioni reali
    (≥ $5M di un lato in 5 minuti). Il CVD del solo perpetual Binance rispetto al prezzo resta all'agente "orderbook": quando
    ne annuncia una divergenza, questo agente risponde con il contesto aggregato degli altri exchange (nessun doppione).
    """

    def finding(self, f: Finding) -> None:
        for i, x in enumerate(list(self.findings)):
            if x["title"] == f.title:
                del self.findings[i]
                break
        self.findings.appendleft(f.as_dict())

    def compute(self):
        return {"sig": _call("terminal", "build_signals")}

    async def act(self, r):
        s = r["sig"]
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
            if div and self.state.get("div") != div:
                await self.say("flow.divergence", text, data={"divergence": div, "spot": cv["spot"], "perp": cv["perp"]})
            self.state["div"] = div
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

    async def on_message(self, m):
        # l'agente orderbook ha visto una divergenza delta/CVD sul solo perpetual Binance: contesto aggregato (se disponibile)
        if m["topic"] != "orderbook.cvd":
            return
        cv = (self.state.get("sig") or {}).get("cvd")
        if not cv:
            return
        same = "conferma" if (cv["perp"] > 0) == (((m.get("data") or {}).get("cvd") or 0) > 0) else "non conferma"
        await self.say("flow.context", f"Contesto multi-exchange: il CVD perp aggregato di Binance, Bybit e OKX nell'ultima ora è {cv['perp']:+,.0f} BTC e "
                       f"{same} la lettura del solo Binance; CVD spot aggregato {cv['spot']:+,.0f} BTC.", to=m["from"], data={"perp": cv["perp"], "spot": cv["spot"]})


STREAM_IT = {"binance_perp": "Binance perp", "bybit_perp": "Bybit perp", "okx_perp": "OKX perp", "binance_spot": "Binance spot",
             "coinbase_spot": "Coinbase", "bybit_spot": "Bybit spot", "okx_spot": "OKX spot"}


class KronosAgent(Agent):
    """Kronos (foundation model per candele): annuncia la previsione corrente 1h/4h/1D (mediana, banda 90%, regime) con il
    verdetto del backtest fuori campione DOPO il pre-addestramento. Tono sempre neutro: descrizione, mai un segnale."""

    REG = {"trend_up": "trend al rialzo", "trend_down": "trend al ribasso", "choppy": "laterale"}
    VER = {"edge": "batte il naive in modo significativo", "small_edge": "batte il naive di poco (significativo)",
           "no_edge": "nessun vantaggio significativo sul naive", "worse": "peggiore del naive (significativo)",
           "worse_ns": "nessun vantaggio sul naive", "n_a": "verdetto non disponibile"}

    def finding(self, f: Finding) -> None:
        for i, x in enumerate(list(self.findings)):
            if x["title"] == f.title:
                del self.findings[i]
                break
        self.findings.appendleft(f.as_dict())

    def compute(self):
        from ..analysis import kronos_forecast as kf  # noqa: PLC0415
        return {"s": kf.summary()}

    async def act(self, r):
        s = r.get("s") or {}
        hl = ((s.get("backtest") or {}).get("headline") or {}).get("small", {})
        for tf in ("1h", "4h", "1d"):
            f = (s.get("forecasts") or {}).get(tf)
            if not f:
                continue
            e, g = f["end"], f["regime"]
            tfl = {"1h": "1h", "4h": "4h", "1d": "1G"}[tf]
            h = hl.get(tf) or {}
            bt = (f"Backtest dopo il pre-addestramento (dal 1 lug 2024), 1 giorno avanti: MASE {h['day_mase']:.3f}, "
                  f"{self.VER.get((h.get('day') or {}).get('code'), 'n/d')}" if h.get("day_mase") is not None else "Backtest non ancora calcolato: nessun verdetto")
            text = (f"Kronos {tfl} (24 candele, 100 percorsi, fino al {util_data(f['target'])}): mediana {_usd(e['median'])} "
                    f"({e['change_pct']:+.2f}%), banda 90% {_k(e['p05'])}–{_k(e['p95'])}, P(rialzo) {e['up_prob']:.0f}%, "
                    f"regime {self.REG.get(g['code'], g['code'])} (accordo dei percorsi {100 * g['agree']:.0f}%). {bt}. "
                    "Descrizione statistica, non un segnale.")
            self.finding(Finding(f"Kronos {tfl}", text, "neutral", 30))
            key = f"{tf}:{f['origin']}"
            if self.state.get(f"k_{tf}") != key:
                await self.say(f"kronos.forecast.{tf}", text, data={"tf": tf, "median": e["median"], "p05": e["p05"], "p95": e["p95"],
                                                                   "up_prob": e["up_prob"], "regime": g["code"], "agree": g["agree"],
                                                                   "bt_day_mase": h.get("day_mase"), "bt_verdict": (h.get("day") or {}).get("code")})
                self.state[f"k_{tf}"] = key


class ForecastAgent(Agent):
    def compute(self):
        out = {"f": _call("forecast", "get_forecast", horizon=90)}
        try:
            from ..analysis import forecast_oneday as fod  # noqa: PLC0415
            out["d1"] = fod.summary()
        except Exception as e:  # noqa: BLE001  (modello a 1 giorno non pronto: il resto dell'agente prosegue)
            log.info("previsione 1g non disponibile per l'agente: %s", e)
            out["d1"] = None
        return out

    def _oneday_finding(self, d1: dict) -> None:
        """Finding sobrio sulla previsione a 1 giorno: valore, bande e verdetto contro il naive (mai un segnale)."""
        tm, a = d1["tomorrow"], d1["all"]
        v = a.get("verdict", {})
        mase, p = a.get("mase"), a.get("dm_p")
        if mase is None:
            return
        verdict = {"edge": "vantaggio significativo sul naive", "small_edge": "vantaggio piccolo ma significativo sul naive",
                   "no_edge": "nessun vantaggio significativo sul naive", "worse": "peggiore del naive",
                   "worse_ns": "nessun vantaggio sul naive"}.get(v.get("code"), "confronto con il naive non disponibile")
        text = (f"Previsione a 1 giorno (chiusura del {util_data(tm['target'])}): {_usd(tm['median'])}, banda 90% "
                f"{_k(tm['p05'])}–{_k(tm['p95'])}, P(rialzo) {tm['up_prob']:.0f}%. Fuori campione dal 2019: MASE {mase:.3f} "
                f"(naive = 1){f', test Diebold-Mariano p = {p:.2f}' if p is not None else ''}: {verdict}. A un giorno la miglior stima resta vicina al "
                "prezzo di oggi.")
        if text not in [f["text"] for f in list(self.findings)[:6]]:
            self.findings.appendleft(Finding("Previsione a 1 giorno", text, "neutral", 35).as_dict())

    async def act(self, r):
        if r.get("d1"):
            self._oneday_finding(r["d1"])
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
        views = []
        for a in bus.agents.values():
            if a.id == self.id:
                continue
            for f in list(a.findings)[:2]:
                views.append({"agent": a.name, "id": a.id, **f})
        rel = _reliability()
        for v in views:
            v["w"] = v["confidence"] * (0.5 + rel.get(v["id"], 0.5))
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
        return {"consensus": consensus, "summary": summary, "n": len(views)}

    async def act(self, r):
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
        AnalystAgent("analyst", "Analista AI", "Orchestratore: raccoglie i report di tutti gli agenti, calcola il consenso e scrive la sintesi (LLM locale).",
                     "BrainCircuit", "#a78bfa", 120, subscribes=["liquidity.", "levels.confluence", "pattern.", "correlation.", "cycle.", "onchain.", "derivatives.signal", "flows.", "analogs.", "timepivot.", "macro.", "clock.", "miners.", "leverage.", "usdt_analogs.", "stablecoins.", "structure.", "opening.", "scenario.", "events.", "verifier.", "options.", "holders.", "sentiment.", "image.", "forecast.", "vwap.", "timing.", "elliott.", "anomalies.", "orderbook.", "flow.", "kronos.", "market.alert", "levels.touch"], publishes=["analyst.summary"]),
        MarketAgent("market", "Market Data", "Monitora prezzo, range 24h e sentiment in tempo reale e avvisa gli altri agenti dei movimenti.",
                    "Activity", "#f7931a", 5, subscribes=[], publishes=["market.price", "market.alert"]),
        LevelsAgent("levels", "Pivot & Livelli", "Calcola pivot (classici, Fibonacci, Camarilla), swing e zone di supporto/resistenza; verifica confluenze su richiesta.",
                    "Layers", "#38bdf8", 30, subscribes=["market.price", "request.levels"], publishes=["levels.key", "levels.touch", "levels.confluence"]),
        LiquidityAgent("liquidity", "Liquidazioni", "Stima la heatmap delle liquidazioni da OI e leva, individua cluster, magneti e pool di liquidità.",
                       "Flame", "#f43f5e", 30, subscribes=["market.price", "derivatives.oi", "request.liquidity"], publishes=["liquidity.cluster", "liquidity.sweep", "request.levels"]),
        PatternAgent("patterns", "Frattali & Pattern", "Cerca nello storico movimenti simili (4H/1D), proietta gli scenari e individua i retest probabili.",
                     "Shapes", "#22d3ee", 60, subscribes=["correlation."], publishes=["pattern.projection", "pattern.retest", "pattern.confirmation", "request.levels"]),
        CorrelationAgent("correlation", "USDT & Correlazioni", "Ricostruisce la USDT dominance, misura correlazioni e lead/lag con BTC, trova divergenze e frattali congiunti.",
                         "GitCompareArrows", "#10b981", 60, subscribes=[], publishes=["correlation.usdt", "correlation.fractal"]),
        CycleAgent("cycles", "Cicli", "Riconosce top/bottom storici, la fase attuale del ciclo e stima in modo adattivo i prossimi top e bottom.",
                   "RefreshCcw", "#fbbf24", 300, subscribes=[], publishes=["cycle.phase"]),
        OnchainAgent("onchain", "On-Chain", "Valuta MVRV, NUPL, prezzo realizzato, hashrate e Puell per capire se BTC è caro o economico.",
                     "Blocks", "#818cf8", 300, subscribes=[], publishes=["onchain.valuation"]),
        DerivativesAgent("derivatives", "Derivati", "Segue funding, open interest, long/short e basis per misurare la leva nel mercato.",
                         "Gauge", "#fb923c", 20, subscribes=[], publishes=["derivatives.funding", "derivatives.oi", "derivatives.signal"]),
        FlowsAgent("flows", "Flussi Spot/Futures", "Confronta acquisti e vendite aggressive su spot e futures perpetual: delta, CVD, divergenze e picchi di leva.",
                   "ArrowLeftRight", "#2dd4bf", 30, subscribes=["derivatives.funding"],
                   publishes=["flows.divergence", "flows.spike", "flows.leverage", "request.liquidity"]),
        AnalogsAgent("analogs", "Analoghi grafici", "Trova nello storico i grafici più simili a quello attuale (forma, candele, gambe, figure) e spiega cosa corrisponde a cosa.",
                     "ScanSearch", "#e879f9", 120, subscribes=["pattern.projection"],
                     publishes=["analogs.match", "analogs.pattern", "analogs.check", "analogs.structure"]),
        TimePivotsAgent("timepivots", "Pivot temporali", "Individua le date in cui BTC ha reagito in modo ricorrente (stagionalità, tempi di ciclo, Fibonacci temporali, eventi) e avvisa quando si avvicinano.",
                        "CalendarClock", "#facc15", 600, subscribes=["cycle.phase"],
                        publishes=["timepivot.next", "timepivot.alert", "timepivot.check"]),
        MacroAgent("macro", "Macro e rotazione", "Segue dollaro, tassi, volatilità, liquidità e rotazione BTC/altcoin; segnala i cambi di regime risk-on/risk-off.",
                   "Globe2", "#94a3b8", 300, subscribes=["correlation.usdt"],
                   publishes=["macro.context", "macro.rotation", "macro.alert", "macro.riskoff", "macro.riskon"]),
        CycleClockAgent("clock", "Orologio del ciclo", "Calcola lo score di ciclo 0-100 (Pi Cycle, MVRV-Z, NUPL, Puell, Mayer, power law...) e confronta oggi con lo stesso giorno dei cicli passati.",
                        "Clock", "#f59e0b", 300, subscribes=["cycle.phase"], publishes=["clock.score", "clock.zone", "clock.compare", "clock.check"]),
        MinerAgent("miners", "Miner", "Segue il ciclo dei miner: Hash Ribbons, Difficulty Ribbon, drawdown dell'hashrate e Puell.",
                   "Pickaxe", "#a3e635", 600, subscribes=[], publishes=["miners.state", "miners.signal"]),
        LeverageAgent("leverage", "Ciclo della leva", "Confronta funding e speculazione (volumi perp/spot) con la fase di ciclo e con i cicli passati.",
                      "Scale", "#fb7185", 300, subscribes=["flows.spike"], publishes=["leverage.cycle", "leverage.check"]),
        UsdtAnalogsAgent("usdt_analogs", "Analoghi USDT", "Cerca nello storico configurazioni grafiche simili della USDT dominance e riporta cosa ha fatto BTC dopo.",
                         "ScanLine", "#34d399", 300, subscribes=["correlation.usdt"], publishes=["usdt_analogs.match"]),
        StablecoinsAgent("stablecoins", "Stablecoin", "Misura la liquidità in stablecoin: supply totale, emissioni nette, dominance e Stablecoin Supply Ratio.",
                         "Coins", "#22c55e", 600, subscribes=[], publishes=["stablecoins.liquidity", "stablecoins.alert"]),
        RangeAgent("range", "Range e struttura", "Riconosce i range sui timeframe alti, gli sweep, le accettazioni e i retest e misura cosa è successo storicamente dopo.",
                   "SquareDashed", "#60a5fa", 60, subscribes=[], publishes=["structure.range", "structure.event"]),
        OpeningPivotAgent("opening", "Pivot di apertura", "Segue massimo e minimo del lunedì, aperture settimanali/mensili e chiusure settimanali con le statistiche di ritorno.",
                          "CalendarRange", "#f59e0b", 60, subscribes=["market.price"], publishes=["opening.monday", "opening.break"]),
        ScenarioAgent("scenarios", "Piano scenari", "Costruisce 2-3 scenari condizionali con trigger, obiettivi e invalidazione combinando struttura, livelli, liquidità, analoghi e pivot.",
                      "Route", "#e2e8f0", 120, subscribes=["structure.event", "opening.break", "liquidity.sweep", "timepivot.alert"],
                      publishes=["scenario.plan"]),
        EventsAgent("events", "Eventi macro", "Segue FOMC, CPI, dati sul lavoro, scadenze opzioni, CME e ciclo politico (midterm) con la reazione storica di BTC.",
                    "CalendarDays", "#94a3b8", 600, subscribes=[], publishes=["events.next", "events.soon"]),
        AstroAgent("astro", "Astronomia e numeri", "Calcola fasi lunari, eclissi, Mercurio retrogrado, ciclo solare e livelli numerici, li testa sullo storico di BTC contro il caso e annuncia gli eventi imminenti con il verdetto statistico.",
                   "MoonStar", "#9B87F5", 1800, subscribes=[], publishes=["astro.summary", "astro.soon"]),
        TimingAgent("timing", "Timing Gann · Wyckoff", "Proietta i conteggi di Gann dai pivot maggiori, riconosce fasi ed eventi di Wyckoff su 1D/4H e verifica i ritmi di calendario: annuncia date chiave, eventi e ritmi sempre con il loro track record contro il caso.",
                    "Hourglass", "#9B87F5", 600, subscribes=[], publishes=["timing.key_date", "timing.wyckoff.1d", "timing.wyckoff.4h", "timing.rhythm"]),
        ElliottAgent("elliott", "Onde di Elliott", "Conta le onde di Elliott su 4H, 1D e 1W con regole rigide e linee guida a punteggio: comunica il conteggio preferito, l'invalidazione, gli obiettivi e i cambi di conteggio, sempre con il verdetto del backtest walk-forward. Solo descrizione, nessun segnale operativo.",
                     "Waves", "#9B87F5", 300, subscribes=[], publishes=["elliott.count.4h", "elliott.count.1d", "elliott.count.1w", "elliott.invalidated"]),
        VerifierAgent("verifier", "Verifica", "Registra le previsioni di ogni agente, le confronta con la realtà e calcola l'affidabilità usata dall'Analista per pesare i pareri.",
                      "BadgeCheck", "#4c8dff", 1800, subscribes=[], publishes=["verifier.summary"]),
        AlertsAgent("alerts", "Avvisi", "Motore delle notifiche: valuta soglie e cooldown, evita lo spam e invia i toast per gli eventi importanti.",
                    "Bell", "#f59e0b", 30, subscribes=[], publishes=["alerts.sent"]),
        OptionsAgent("options", "Opzioni", "Legge il mercato opzioni Deribit: max pain delle scadenze, put/call, skew, volatilità implicita e muri di gamma.",
                     "Sigma", "#a78bfa", 120, subscribes=[], publishes=["options.state", "request.levels"]),
        HoldersAgent("holders", "Holder STH/LTH", "Segue il prezzo medio di carico e l'MVRV degli holder recenti e di lungo periodo (dati con 7 giorni di ritardo).",
                     "Users", "#5eead4", 1800, subscribes=[], publishes=["holders.state", "holders.cross"]),
        SentimentAgent("sentiment", "Sentiment", "Indice contrarian di paura/euforia (Fear & Greed, funding, flussi, premio Coinbase, skew, DVOL) con backtest.",
                       "Thermometer", "#f472b6", 300, subscribes=[], publishes=["sentiment.state", "sentiment.extreme"]),
        SupplyDemandAgent("supply_demand", "Domanda e offerta", "Segue riserve e flussi degli exchange, flussi degli ETF spot con l'assorbimento dei BTC emessi dai miner e l'attenzione retail su Wikipedia.",
                          "Coins", "#3CC6B0", 1800, subscribes=[], publishes=["supply.exchanges", "supply.etf", "supply.etf.big", "supply.attention"]),
        ImagePatternAgent("image", "Ricerca da immagine", "Legge gli screenshot di TradingView caricati dall'utente, ricostruisce le candele e cerca nello storico i pattern più simili.",
                          "ImageUp", "#e879f9", 15, subscribes=[], publishes=["image.match"]),
        CustomAlertsAgent("custom_alerts", "Avvisi personali", "Controlla le regole personali dell'utente su prezzo, livelli e indicatori e informa il team quando scattano.",
                          "BellRing", "#fbbf24", 60, subscribes=[], publishes=["custom.state", "custom.fired"]),
        JournalAgent("journal", "Diario", "Verifica alla scadenza le viste annotate nel diario e tiene il conto dell'hit rate per orizzonte e direzione.",
                     "NotebookPen", "#94a3b8", 600, subscribes=[], publishes=["journal.state", "journal.review"]),
        DerivSignalsAgent("basis", "Basis futures", "Calcola il basis annualizzato e la curva dei futures (Deribit, Binance COIN-M e USDⓈ-M) con percentile storico e verifica sul dato ufficiale.",
                          "TrendingUp", "#38bdf8", 900, subscribes=[], publishes=["basis.state"]),
        DerivSignalsAgent("cme", "CME COT", "Legge il Commitment of Traders CFTC sui futures Bitcoin CME (leveraged funds, asset manager, dealer) e lo verifica sul report ufficiale.",
                          "Scale", "#818cf8", 3600, subscribes=[], publishes=["cme.state"]),
        DerivSignalsAgent("agg_leverage", "Leva aggregata", "Somma open interest, funding e long/short di Binance, Bybit e OKX in un'unica misura della leva sul mercato perpetual.",
                          "Layers", "#f97316", 300, subscribes=[], publishes=["agg_leverage.state"]),
        VwapAgent("vwap", "VWAP ancorati", "Calcola i VWAP settimanale, mensile, trimestrale e annuale (ancore UTC, bande ±σ) e i livelli del periodo precedente; segnala posizione del prezzo, cross e tocchi.",
                  "Anchor", "#3CC6B0", 60, subscribes=[], publishes=["vwap.position", "vwap.cross", "vwap.touch", "vwap.confluence"]),
        AnomalyAgent("anomalies", "Anomalie", "Cerca valori anomali (z robusto senza dati futuri) in funding, open interest, liquidazioni, volume e flussi ETF/exchange e li annuncia con il backtest storico di cosa è successo dopo.",
                     "Radar", "#E8B04B", 1800, subscribes=[], publishes=["anomalies.funding", "anomalies.oi", "anomalies.liq_long", "anomalies.liq_short",
                                                                        "anomalies.volume", "anomalies.etf", "anomalies.exchange"]),
        OrderBookAgent("orderbook", "Order book", "Legge il book Binance perpetual raccolto in tempo reale: muri di liquidità vicini al prezzo (soglia k× la mediana), liquidità ritirata prima del tocco, squilibri bid/ask persistenti e delta/CVD divergenti dal prezzo. Solo descrizione, nessun segnale operativo.",
                       "Grid3x3", "#5B8DEF", 30, subscribes=[], publishes=["orderbook.walls", "orderbook.pulled", "orderbook.imbalance", "orderbook.cvd"]),
        TerminalFlowAgent("flow", "Order flow", "Segue i trade di sette mercati (Binance, Bybit e OKX perp e spot, Coinbase): divergenze tra CVD spot e perp aggregati, squilibri persistenti di acquisti e vendite aggressivi, grandi trade e raffiche di liquidazioni reali. Solo descrizione, nessun segnale operativo.",
                          "AudioWaveform", "#3CC6B0", 60, subscribes=["orderbook.cvd"], publishes=["flow.divergence", "flow.imbalance", "flow.large", "flow.liquidations", "flow.context"]),
        KronosAgent("kronos", "Kronos", "Foundation model per candele (Kronos-small, arXiv:2508.02739): percorsi probabilistici 1h/4h/1G con mediana, bande e regime, sempre accompagnati dal backtest fuori campione dopo il pre-addestramento.",
                    "Sparkles", "#9B87F5", 120, subscribes=[], publishes=["kronos.forecast.1h", "kronos.forecast.4h", "kronos.forecast.1d"]),
        ForecastAgent("forecast", "Previsioni ML", "Posizione nel ciclo + LightGBM + Monte Carlo, calibrati fuori campione: bande di probabilità da 7 a 365 giorni; previsione a 1 giorno confrontata con il naive.",
                      "TrendingUp", "#60a5fa", 600, subscribes=["pattern.projection.d1"], publishes=["forecast.targets", "forecast.check"]),
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
    order = {"market": 1, "derivatives": 3, "levels": 5, "liquidity": 8, "correlation": 11, "cycles": 14,
             "onchain": 17, "patterns": 20, "forecast": 25, "flows": 6, "analogs": 22, "timepivots": 30, "macro": 33, "clock": 36, "miners": 38, "leverage": 40, "usdt_analogs": 42, "stablecoins": 44, "range": 46, "opening": 48, "scenarios": 52, "events": 54, "verifier": 70, "alerts": 12, "options": 56, "holders": 58, "sentiment": 62, "supply_demand": 64, "image": 9, "vwap": 4, "timing": 60, "elliott": 57, "anomalies": 50, "orderbook": 15, "flow": 19, "kronos": 68, "analyst": 66}
    loop = asyncio.get_running_loop()
    for a in team:
        loop.create_task(a.inbox_loop())
        loop.create_task(a.loop(order.get(a.id, 5)))
    log.info("team di %d agenti avviato", len(team))


def graph() -> dict:
    edges: dict[tuple[str, str], dict] = {}
    # grafo statico dalle sottoscrizioni
    for a in bus.agents.values():
        for t in a.publishes:
            for b in bus.subscribers(t):
                if b.id != a.id:
                    e = edges.setdefault((a.id, b.id), {"topics": set(), "count": 0, "last": None})
                    e["topics"].add(t)
    # richieste dirette osservate
    for k, v in bus.edges.items():
        e = edges.setdefault(k, {"topics": set(), "count": 0, "last": None})
        e["topics"] |= v["topics"]
        e["count"] = v["count"]
        e["last"] = v["last"]
    return {
        "agents": [a.to_dict() for a in bus.agents.values()],
        "edges": [{"from": f, "to": t, "topics": sorted(v["topics"]), "count": v["count"], "last": v["last"]} for (f, t), v in edges.items()],
        "started_at": _started_at,
    }


_started_at = _now()


def messages(limit: int = 100, agent: str | None = None) -> list[dict]:
    out = []
    for m in bus.messages:
        if agent and agent not in (m["from"], m["to"]):
            continue
        out.append(m)
        if len(out) >= limit:
            break
    return out


def dumps(obj) -> str:
    return json.dumps(obj)
