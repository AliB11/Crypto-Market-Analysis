"""Shared pytest fixtures: in-memory repositories, faked Redis hub, app client.

The suite never touches PostgreSQL, Redis, HuggingFace or any exchange –
every collaborator is substituted through FastAPI dependency overrides or
constructor injection, exactly at the seams the production code exposes.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

import pytest

# Test mode BEFORE importing the app: skips lifespan service connections.
os.environ.setdefault("TESTING", "1")
os.environ.setdefault("RATELIMIT_ENABLED", "false")
os.environ.setdefault("SYMBOLS", "BTC,ETH")

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402
from services.quantitative import (  # noqa: E402
    DerivativeObservation,
    OHLCVBar,
    SocialObservation,
)


# ===========================================================================
# Deterministic synthetic market data
# ===========================================================================
def make_bars(
    n: int = 400,
    start_price: float = 50_000.0,
    drift: float = 0.0002,
    volatility: float = 0.004,
    volume: float = 12_000.0,
    seed: int = 7,
) -> List[OHLCVBar]:
    """Geometric-random-walk candles (reproducible via ``seed``)."""
    import random

    n = int(n)
    rng = random.Random(seed)
    now = datetime.now(timezone.utc)
    price = start_price
    bars: List[OHLCVBar] = []
    for index in range(n):
        shock = rng.gauss(0.0, volatility)
        new_price = max(1e-8, price * (1.0 + drift + shock))
        high = max(price, new_price) * (1.0 + abs(rng.gauss(0, volatility / 2)))
        low = min(price, new_price) * (1.0 - abs(rng.gauss(0, volatility / 2)))
        bars.append(
            OHLCVBar(
                timestamp=now - timedelta(minutes=n - index),
                open=price,
                high=high,
                low=low,
                close=new_price,
                volume=max(0.0, volume * (0.5 + rng.random())),
            )
        )
        price = new_price
    return bars


def make_social(
    n: int = 60,
    polarity_bias: float = 0.3,
    seed: int = 11,
) -> List[SocialObservation]:
    import random

    n = int(n)
    rng = random.Random(seed)
    now = datetime.now(timezone.utc)
    return [
        SocialObservation(
            timestamp=now - timedelta(hours=n - index),
            polarity=max(-1.0, min(1.0, rng.gauss(polarity_bias, 0.35))),
            confidence=rng.uniform(0.55, 0.98),
            weight=rng.uniform(1.0, 9.0),
            platform="twitter",
        )
        for index in range(n)
    ]


def make_derivatives(
    n: int = 24,
    funding: float = 0.0001,
    oi_base: float = 500_000.0,
    oi_growth: float = 0.02,
) -> List[DerivativeObservation]:
    now = datetime.now(timezone.utc)
    return [
        DerivativeObservation(
            timestamp=now - timedelta(hours=n - index),
            funding_rate=funding,
            open_interest=oi_base * (1.0 + oi_growth) ** index,
            long_short_ratio=1.1,
        )
        for index in range(n)
    ]


# ===========================================================================
# In-memory repository fakes
# ===========================================================================
class FakeMarketRepo:
    def __init__(self, bars: Sequence[OHLCVBar]) -> None:
        self.by_symbol: Dict[str, List[OHLCVBar]] = {"BTC": list(bars)}

    async def insert_bars(self, rows: Sequence[tuple]) -> None:  # pragma: no cover
        return None

    async def fetch_bucketed(
        self, symbol: str, resolution: str, limit: int = 500, since: Optional[datetime] = None
    ) -> List[OHLCVBar]:
        bars = [
            b
            for b in self.by_symbol.get(symbol.upper(), [])
            if since is None or b.timestamp >= since
        ]
        seconds = {"5m": 300, "1h": 3600, "1d": 86400}.get(resolution, 300)
        buckets: Dict[int, OHLCVBar] = {}
        for bar in bars:
            key = int(bar.timestamp.timestamp()) // seconds * seconds
            stamp = datetime.fromtimestamp(key, tz=timezone.utc)
            if key not in buckets:
                buckets[key] = OHLCVBar(stamp, bar.open, bar.high, bar.low, bar.close, bar.volume)
            else:
                existing = buckets[key]
                buckets[key] = OHLCVBar(
                    stamp,
                    existing.open,
                    max(existing.high, bar.high),
                    min(existing.low, bar.low),
                    bar.close,
                    existing.volume + bar.volume,
                )
        return sorted(buckets.values(), key=lambda b: b.timestamp)[-limit:]

    async def fetch_raw(
        self, symbol: str, limit: int = 1000, since: Optional[datetime] = None
    ) -> List[OHLCVBar]:
        bars = self.by_symbol.get(symbol.upper(), [])
        return [b for b in bars if since is None or b.timestamp >= since][-limit:]

    async def latest_close(self, symbol: str) -> Optional[float]:
        bars = self.by_symbol.get(symbol.upper(), [])
        return bars[-1].close if bars else None


class FakeSentimentRepo:
    def __init__(self) -> None:
        self.hourly: Dict[str, List[Tuple[datetime, float]]] = {}

    async def insert_records(self, rows: Sequence[tuple]) -> int:
        return len(rows)

    async def fetch_observations(
        self, symbol: str, since: Optional[datetime] = None, limit: int = 2000
    ) -> List[SocialObservation]:
        return []

    async def hourly_weighted_polarity(
        self, symbol: str, window_hours: int = 72
    ) -> List[Tuple[datetime, float]]:
        return self.hourly.get(symbol.upper(), [])

    async def count_recent(self, symbol: str, hours: int = 24) -> int:
        return len(self.hourly.get(symbol.upper(), []))


class FakeDerivativeRepo:
    def __init__(self, observations: Sequence[DerivativeObservation]) -> None:
        self._observations = list(observations)

    async def insert_snapshots(self, rows: Sequence[tuple]) -> None:  # pragma: no cover
        return None

    async def fetch_observations(
        self, symbol: str, since: Optional[datetime] = None, limit: int = 500
    ) -> List[DerivativeObservation]:
        return [o for o in self._observations if since is None or o.timestamp >= since][:limit]


class FakeSignalRepo:
    def __init__(self) -> None:
        self.snapshots: List[dict] = []

    async def insert_snapshot(self, symbol: str, payload: dict) -> None:
        self.snapshots.append({**payload, "symbol": symbol})

    async def latest(self, symbol: str):
        return None


# ===========================================================================
# In-memory Redis bus / stream hub fake for WebSocket tests
# ===========================================================================
class FakeRedis:
    def __init__(self) -> None:
        self.store: Dict[str, str] = {}

    async def get(self, key: str) -> Optional[str]:
        return self.store.get(key)

    async def set(self, key: str, value: str, ex: Optional[int] = None, nx: bool = False) -> bool:
        if nx and key in self.store:
            return False
        self.store[key] = value
        return True

    async def ping(self) -> bool:
        return True


class _BusStub:
    """Duck-typed RedisBus used by the WS gateway snapshot path."""

    def __init__(self, redis: FakeRedis) -> None:
        self.client = redis


class FakeStreamHub:
    """Yields a scripted sequence of frames, then blocks until more arrive."""

    def __init__(self) -> None:
        self.frames: List[Dict[str, Any]] = []
        self._event: Optional[asyncio.Event] = None

    def push(self, frame: Dict[str, Any]) -> None:
        self.frames.append(frame)
        if self._event is not None:
            self._event.set()

    async def stream(self, symbol: str):
        index = 0
        while True:
            while index < len(self.frames):
                yield self.frames[index]
                index += 1
            self._event = asyncio.Event()
            await self._event.wait()
            self._event = None


# ===========================================================================
# Fixtures
# ===========================================================================
@pytest.fixture()
def sample_bars() -> List[OHLCVBar]:
    return make_bars()


@pytest.fixture()
def sample_social() -> List[SocialObservation]:
    return make_social()


@pytest.fixture()
def sample_derivatives() -> List[DerivativeObservation]:
    return make_derivatives()


@pytest.fixture()
def fake_redis() -> FakeRedis:
    return FakeRedis()


@pytest.fixture()
def fake_hub() -> FakeStreamHub:
    return FakeStreamHub()


@pytest.fixture()
def api_client(fake_hub: FakeStreamHub, fake_redis: FakeRedis):
    """FastAPI TestClient wired to in-memory collaborators."""
    from deps import (
        get_derivative_repo,
        get_market_repo,
        get_sentiment_repo,
        get_signal_repo,
    )

    market_repo = FakeMarketRepo(make_bars())
    sentiment_repo = FakeSentimentRepo()
    derivative_repo = FakeDerivativeRepo(make_derivatives())

    app.dependency_overrides[get_market_repo] = lambda: market_repo
    app.dependency_overrides[get_sentiment_repo] = lambda: sentiment_repo
    app.dependency_overrides[get_derivative_repo] = lambda: derivative_repo
    app.dependency_overrides[get_signal_repo] = lambda: FakeSignalRepo()
    app.state.redis_bus = _BusStub(fake_redis)
    app.state.stream_hub = fake_hub

    with TestClient(app) as client:
        yield client

    app.dependency_overrides.clear()
