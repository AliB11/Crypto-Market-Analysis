#!/usr/bin/env python3
"""Live demo API for the Crypto Intelligence Terminal (sandbox/preview mode).

Runs the **production FastAPI application** (backend/main.py) with the
persistence layer swapped for the in-memory fakes used by the pytest suite,
and a synthetic data fabric that drives the exact same Redis-pub/sub frame
format the real ingestion workers emit.

This exists so the terminal can be demonstrated end-to-end (REST hydration +
multiplexed WebSocket + the real QuantitativeEngine) without exchange API
keys, social platform credentials, PostgreSQL or Redis.  It is NOT part of
the production runtime.

    python scripts/demo_api.py --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import math
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))
sys.path.insert(0, str(BACKEND_DIR / "tests"))

import os  # noqa: E402

os.environ["TESTING"] = "1"
os.environ["RATELIMIT_ENABLED"] = "false"
os.environ["SYMBOLS"] = "BTC,ETH,SOL,BNB,XRP,DOGE,ADA"
os.environ["LOG_LEVEL"] = "INFO"

from conftest import (  # noqa: E402
    FakeMarketRepo,
    FakeStreamHub,
    _BusStub,
    make_bars,
)
from deps import (  # noqa: E402
    get_derivative_repo,
    get_market_repo,
    get_sentiment_repo,
    get_signal_repo,
)
from main import app  # noqa: E402
from services.quantitative import (  # noqa: E402
    DerivativeObservation,
    OHLCVBar,
    QuantitativeEngine,
    SocialObservation,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(name)s :: %(message)s")
logger = logging.getLogger("demo")

SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA"]
BASE_PRICES = {"BTC": 67_300, "ETH": 3_450, "SOL": 172, "BNB": 610, "XRP": 0.62, "DOGE": 0.16, "ADA": 0.98}
BASE_VOLUMES = {"BTC": 48_000, "ETH": 32_000, "SOL": 21_000, "BNB": 12_000, "XRP": 9_000, "DOGE": 8_000, "ADA": 6_500}

DEMO_AUTHORS = [
    ("quantedge", 184_000), ("MacroDesks", 96_400), ("crypto_whale_", 412_000),
    ("chain_sentinel", 57_800), ("degenscience", 22_100), ("OptionsFlow", 133_700),
]
DEMO_SEEDS = {s: 100 + index * 7 for index, s in enumerate(SYMBOLS)}
DEMO_TEXTS = [
    ("BTC", "bitcoin etf inflows are accelerating again, structural bid intact", 0.85),
    ("BTC", "bitcoin funding getting rich, longs crowded at these levels", -0.55),
    ("ETH", "ethereum L2 activity at all time highs, fee burn accelerating", 0.8),
    ("SOL", "solana network congestion again, validators struggling", -0.7),
    ("ETH", "staking withdrawals queue is empty, supply squeeze forming", 0.6),
    ("BTC", "this bitcoin pump looks like a bull trap, watch the weekly close", -0.75),
    ("DOGE", "dogecoin volume spike is purely speculative rotation", 0.35),
    ("SOL", "solana DEX volumes flipping ethereum weekly, real usage", 0.75),
    ("XRP", "xrp ledger usage growing but price action remains range bound", 0.1),
    ("ADA", "cardano governance vote passed quietly, nothing burger", -0.2),
]


class DemoState:
    """Synthetic market + social + derivative fabric per symbol."""

    def __init__(self) -> None:
        self.rng = random.Random(20260920)
        self.market = FakeMarketRepo([])
        self.hub = FakeStreamHub()
        self.now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        self.observations: Dict[str, List[SocialObservation]] = {s: [] for s in SYMBOLS}
        self.hourly: Dict[str, List[tuple]] = {s: [] for s in SYMBOLS}
        self.derivatives: Dict[str, List[DerivativeObservation]] = {s: [] for s in SYMBOLS}
        self.drift: Dict[str, float] = {s: self.rng.uniform(-0.0008, 0.0012) for s in SYMBOLS}
        self.phase = 0.0
        self.store_signal = lambda symbol, payload: None  # wired in main()

        for symbol in SYMBOLS:
            bars = make_bars(
                n=720,
                start_price=BASE_PRICES[symbol],
                drift=self.drift[symbol],
                volatility=0.0025,
                volume=BASE_VOLUMES[symbol] / 10,
                seed=DEMO_SEEDS[symbol],
            )
            # Rebase timestamps so the demo starts "now".
            offset = self.now - bars[-1].timestamp
            bars = [
                OHLCVBar(
                    b.timestamp + offset, b.open, b.high, b.low, b.close, b.volume
                )
                for b in bars
            ]
            self.market.by_symbol[symbol] = list(bars)
            self.observations[symbol] = self._seed_observations(symbol)
            self.hourly[symbol] = self._seed_hourly(symbol)
            self.derivatives[symbol] = self._seed_derivatives(symbol)

    # ------------------------------------------------------------- seeding
    def _seed_observations(self, symbol: str) -> List[SocialObservation]:
        observations = []
        for index in range(60):
            polarity = max(
                -1.0,
                min(1.0, self.rng.gauss(self.drift[symbol] * 900, 0.45)),
            )
            observations.append(
                SocialObservation(
                    timestamp=self.now - timedelta(minutes=(60 - index) * 45),
                    polarity=polarity,
                    confidence=self.rng.uniform(0.6, 0.97),
                    weight=self.rng.uniform(1.0, 11.0),
                )
            )
        return observations

    def _seed_hourly(self, symbol: str):
        polarity = 0.15 if self.drift[symbol] > 0 else -0.2
        return [
            (self.now - timedelta(hours=72 - i), polarity + math.sin(i / 7) * 0.3)
            for i in range(72)
        ]

    def _seed_derivatives(self, symbol: str) -> List[DerivativeObservation]:
        base_oi = BASE_VOLUMES[symbol] * 40
        funding = 0.0002 if self.drift[symbol] > 0 else -0.0001
        return [
            DerivativeObservation(
                timestamp=self.now - timedelta(hours=48 - i),
                funding_rate=funding + math.sin(i / 6) * 0.00008,
                open_interest=base_oi * (1 + 0.004 * i),
                long_short_ratio=1.05 + math.sin(i / 9) * 0.35,
            )
            for i in range(48)
        ]

    # ------------------------------------------------------- tick simulation
    def step_minute(self) -> None:
        """Advance the fabric by one simulated minute."""
        self.now += timedelta(minutes=1)
        self.phase += 0.08
        for symbol in SYMBOLS:
            bars = self.market.by_symbol[symbol]
            last = bars[-1]
            shock = self.rng.gauss(0, 0.0016)
            drift = self.drift[symbol] + 0.0004 * math.sin(self.phase)
            new_close = max(1e-6, last.close * (1 + drift + shock))
            high = max(last.close, new_close) * (1 + abs(self.rng.gauss(0, 0.0008)))
            low = min(last.close, new_close) * (1 - abs(self.rng.gauss(0, 0.0008)))
            volume = BASE_VOLUMES[symbol] / 10 * (0.4 + self.rng.random())
            bar = OHLCVBar(self.now, last.close, high, low, new_close, volume)
            bars.append(bar)
            if len(bars) > 4000:
                bars.pop(0)

            self.hub.push(
                {
                    "channel": "price",
                    "type": "candle",
                    "symbol": symbol,
                    "data": {
                        "symbol": symbol,
                        "pair": f"{symbol}/USDT",
                        "time": int(bar.timestamp.timestamp()),
                        "open": bar.open,
                        "high": bar.high,
                        "low": bar.low,
                        "close": bar.close,
                        "volume": bar.volume,
                    },
                }
            )
            self.hub.push(
                {
                    "channel": "price",
                    "type": "tick",
                    "symbol": symbol,
                    "data": {
                        "symbol": symbol,
                        "pair": f"{symbol}/USDT",
                        "price": bar.close,
                        "change_pct": (bar.close / bars[-145].close - 1) * 100 if len(bars) > 145 else 0.4,
                        "quote_volume": BASE_VOLUMES[symbol] * 24,
                    },
                }
            )

            # sentiment evolution
            if self.rng.random() < 0.5:
                self._emit_social(symbol)

            # derivatives evolution
            if int(self.now.timestamp()) % 600 < 60:
                self._emit_derivative(symbol)

    def _emit_social(self, symbol: str) -> None:
        symbol_texts = [t for t in DEMO_TEXTS if t[0] == symbol]
        if not symbol_texts:
            symbol_texts = [t for t in DEMO_TEXTS if t[0] == "BTC"]
        _, text, polarity = self.rng.choice(symbol_texts)
        author, reach = self.rng.choice(DEMO_AUTHORS)
        confidence = self.rng.uniform(0.62, 0.97)
        weight = math.log1p(reach * 0.001 + self.rng.uniform(5, 300))
        record = {
            "channel": "sentiment",
            "type": "alert" if abs(polarity) > 0.45 and confidence > 0.65 else "update",
            "symbol": symbol,
            "data": {
                "platform": "twitter" if self.rng.random() < 0.7 else "reddit",
                "symbol": symbol,
                "author": author,
                "author_reach": reach,
                "engagement": int(reach * self.rng.uniform(0.0005, 0.02)),
                "text": text,
                "polarity": polarity,
                "confidence": confidence,
                "label": "positive" if polarity > 0 else "negative",
                "weight": weight,
                "timestamp": self.now.isoformat(),
            },
        }
        self.hub.push(record)
        self.observations[symbol].append(
            SocialObservation(self.now, polarity, confidence, weight)
        )
        if len(self.observations[symbol]) > 600:
            self.observations[symbol].pop(0)
        # hourly series evolves toward the emitted polarity
        hourly = self.hourly[symbol]
        if hourly and (self.now - hourly[-1][0]).total_seconds() >= 3600:
            hourly.append((self.now, 0.6 * hourly[-1][1] + 0.4 * polarity))
        elif hourly:
            hourly[-1] = (hourly[-1][0], 0.85 * hourly[-1][1] + 0.15 * polarity)

    def _emit_derivative(self, symbol: str) -> None:
        series = self.derivatives[symbol]
        latest = series[-1]
        funding = latest.funding_rate + self.rng.gauss(0, 0.00004)
        oi = latest.open_interest * (1 + self.rng.gauss(0.001, 0.004))
        lsr = max(0.4, min(2.2, latest.long_short_ratio + self.rng.gauss(0, 0.04)))
        snapshot = DerivativeObservation(self.now, funding, oi, lsr)
        series.append(snapshot)
        if len(series) > 800:
            series.pop(0)
        self.hub.push(
            {
                "channel": "derivatives",
                "type": "snapshot",
                "symbol": symbol,
                "data": {
                    "funding_rate": funding,
                    "open_interest": oi,
                    "long_short_ratio": lsr,
                    "as_of": self.now.isoformat(),
                },
            }
        )

    def emit_confluence(self, symbol: str) -> Dict:
        engine = QuantitativeEngine()
        result = engine.compute_confluence(
            symbol,
            self.market.by_symbol[symbol][-800:],
            self.observations[symbol][-300:],
            self.derivatives[symbol][-60:],
            now=self.now,
        )
        payload = {
            "symbol": symbol,
            "score": round(result.score, 2),
            "regime": result.regime,
            "confidence": round(result.confidence, 4),
            "technical": result.technical.normalised,
            "sentiment": result.sentiment.normalised,
            "derivative": result.derivative.normalised,
            "technical_detail": {
                "rsi": result.technical.rsi,
                "macd_line": result.technical.macd.macd_line if result.technical.macd else None,
                "macd_signal": result.technical.macd.signal_line if result.technical.macd else None,
                "macd_histogram": result.technical.macd.histogram if result.technical.macd else None,
                "historical_volatility_30d": result.technical.historical_volatility,
                "last_close": result.technical.last_close,
            },
            "sentiment_detail": {
                "weighted_polarity": result.sentiment.weighted_polarity,
                "velocity": result.sentiment.velocity,
                "divergence": (
                    {
                        "kind": result.sentiment.divergence.kind,
                        "detected_at": result.sentiment.divergence.detected_at.isoformat(),
                        "price_pivot_time": result.sentiment.divergence.price_pivot_time.isoformat(),
                        "price_from": result.sentiment.divergence.price_from,
                        "price_to": result.sentiment.divergence.price_to,
                        "sentiment_from": result.sentiment.divergence.sentiment_from,
                        "sentiment_to": result.sentiment.divergence.sentiment_to,
                        "strength": result.sentiment.divergence.strength,
                    }
                    if result.sentiment.divergence
                    else None
                ),
                "sample_size": result.sentiment.sample_size,
            },
            "derivative_detail": {
                "funding_rate": result.derivative.funding_rate,
                "funding_deviation": result.derivative.funding_deviation,
                "open_interest": result.derivative.open_interest,
                "open_interest_delta_24h_pct": result.derivative.open_interest_delta_pct,
                "long_short_ratio": result.derivative.long_short_ratio,
            },
            "warnings": list(result.warnings),
            "computed_at": result.computed_at.isoformat(),
        }
        self.hub.push(
            {
                "channel": "signal",
                "type": "confluence",
                "symbol": symbol,
                "data": payload,
            }
        )
        return payload


# ---------------------------------------------------------------------------
# In-memory repositories serving the demo fabric
# ---------------------------------------------------------------------------
class DemoSentimentRepo:
    def __init__(self, state: DemoState) -> None:
        self.state = state

    async def insert_records(self, rows):  # pragma: no cover
        return len(rows)

    async def fetch_observations(self, symbol, since=None, limit=2000):
        return [o for o in self.state.observations.get(symbol.upper(), [])][-limit:]

    async def hourly_weighted_polarity(self, symbol, window_hours=72):
        return self.state.hourly.get(symbol.upper(), [])[-window_hours:]

    async def count_recent(self, symbol, hours=24):
        return len(self.state.observations.get(symbol.upper(), []))


class DemoDerivativeRepo:
    def __init__(self, state: DemoState) -> None:
        self.state = state

    async def insert_snapshots(self, rows):  # pragma: no cover
        return None

    async def fetch_observations(self, symbol, since=None, limit=500):
        return list(self.state.derivatives.get(symbol.upper(), []))[-limit:]


class DemoSignalRepo:
    async def insert_snapshot(self, symbol, payload):  # pragma: no cover
        return None

    async def latest(self, symbol):  # pragma: no cover
        return None


class DemoRedis:
    """Cache for the WS snapshot path."""

    def __init__(self) -> None:
        self.store: Dict[str, str] = {}

    async def get(self, key: str) -> Optional[str]:
        return self.store.get(key)

    async def set(self, key, value, ex=None, nx=False):
        if nx and key in self.store:
            return False
        self.store[key] = value
        return True

    async def ping(self):
        return True


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------
async def fabric_loop(state: DemoState) -> None:
    """Advance the synthetic fabric forever (~1 simulated minute per second)."""
    tick = 0
    while True:
        state.step_minute()
        tick += 1
        if tick % 30 == 0:  # recompute confluence every 30 simulated minutes
            for symbol in SYMBOLS:
                payload = state.emit_confluence(symbol)
                state.store_signal(symbol, payload)
        if tick % 60 == 0:
            logger.info(
                "fabric tick %d: BTC=%.2f drift=%+.5f",
                tick,
                state.market.by_symbol["BTC"][-1].close,
                state.drift["BTC"],
            )
        # Occasionally flip a market regime to keep the demo interesting.
        if tick % 240 == 0:
            for symbol in SYMBOLS:
                state.drift[symbol] = state.rng.uniform(-0.0012, 0.0016)
        await asyncio.sleep(1.0)


def main() -> None:
    parser = argparse.ArgumentParser(description="Crypto Intelligence Terminal demo API")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    state = DemoState()

    # Ensure the demo hub survives app lifespan (set BEFORE startup).
    app.state.stream_hub = state.hub

    # A tiny cache shim so the WS snapshot frame can read latest signals.
    redis = DemoRedis()
    state.store_signal = lambda symbol, payload: redis.store.__setitem__(
        f"latest:signal:{symbol}", json.dumps(payload)
    )
    app.state.redis_bus = _BusStub(redis)  # type: ignore[arg-type]

    app.dependency_overrides[get_market_repo] = lambda: state.market
    app.dependency_overrides[get_sentiment_repo] = lambda: DemoSentimentRepo(state)
    app.dependency_overrides[get_derivative_repo] = lambda: DemoDerivativeRepo(state)
    app.dependency_overrides[get_signal_repo] = lambda: DemoSignalRepo()

    import uvicorn

    config = uvicorn.Config(app, host=args.host, port=args.port, log_level="info")
    server = uvicorn.Server(config)

    async def serve() -> None:
        fabric = asyncio.create_task(fabric_loop(state))
        try:
            await server.serve()
        finally:
            fabric.cancel()

    asyncio.run(serve())


if __name__ == "__main__":
    main()
