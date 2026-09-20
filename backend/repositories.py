"""Data access layer over TimescaleDB.

Repositories translate between raw asyncpg rows and the typed value objects
of :mod:`services.quantitative`.  They are the *only* place where SQL lives,
which keeps the quant engine pure and lets the pytest suite swap the whole
persistence layer out via FastAPI dependency overrides.

All queries target the hypertables created by ``database/init.sql`` and lean
on native TimescaleDB primitives (``time_bucket``, ``first``/``last``,
``drop_chunks``).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Sequence, Tuple

import asyncpg

from services.quantitative import (
    DerivativeObservation,
    OHLCVBar,
    SocialObservation,
)

logger = logging.getLogger(__name__)

# Resolution -> (bucket interval, default lookback).
_RESOLUTION_INTERVALS = {
    "5m": ("5 minutes", timedelta(hours=12)),
    "1h": ("1 hour", timedelta(days=14)),
    "1d": ("1 day", timedelta(days=180)),
}
_BASE_RESOLUTION = "1m"


def _ensure_tz(timestamp: datetime) -> datetime:
    """Guarantee timezone-aware timestamps regardless of driver settings."""
    if timestamp.tzinfo is None:
        return timestamp.replace(tzinfo=timezone.utc)
    return timestamp


class MarketRepository:
    """Read/write access to the ``market_ohlcv`` hypertable."""

    def __init__(self, db) -> None:  # db: db.Database (loose type for DI)
        self._db = db

    async def insert_bars(self, rows: Sequence[tuple]) -> None:
        """Bulk insert 1m bars (idempotent via PK upsert).

        ``rows`` are tuples of ``(timestamp, symbol, resolution, open, high,
        low, close, volume)``.
        """
        if not rows:
            return
        await self._db.executemany(
            """
            INSERT INTO market_ohlcv
                (timestamp, symbol, resolution, open, high, low, close, volume)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (symbol, resolution, timestamp) DO UPDATE
            SET open = EXCLUDED.open,
                high = EXCLUDED.high,
                low = EXCLUDED.low,
                close = EXCLUDED.close,
                volume = EXCLUDED.volume
            """,
            rows,
        )

    async def fetch_bucketed(
        self,
        symbol: str,
        resolution: str,
        limit: int = 500,
        since: Optional[datetime] = None,
    ) -> List[OHLCVBar]:
        """Return OHLCV bars aggregated on the fly from the 1m base grain.

        Uses ``time_bucket`` with ``first``/``last`` open/close selection so
        candle semantics are exact even across missing minutes.
        """
        interval, default_lookback = _RESOLUTION_INTERVALS[resolution]
        since = since or datetime.now(timezone.utc) - default_lookback
        records = await self._db.fetch(
            """
            SELECT time_bucket($1::interval, timestamp) AS bucket,
                   first(open, timestamp)  AS open,
                   max(high)               AS high,
                   min(low)                AS low,
                   last(close, timestamp)  AS close,
                   sum(volume)             AS volume
            FROM market_ohlcv
            WHERE symbol = $2 AND resolution = $3 AND timestamp >= $4
            GROUP BY bucket
            ORDER BY bucket DESC
            LIMIT $5
            """,
            interval,
            symbol.upper(),
            _BASE_RESOLUTION,
            since,
            limit,
        )
        bars = [
            OHLCVBar(
                timestamp=_ensure_tz(r["bucket"]),
                open=float(r["open"]),
                high=float(r["high"]),
                low=float(r["low"]),
                close=float(r["close"]),
                volume=float(r["volume"] or 0.0),
            )
            for r in records
        ]
        bars.reverse()  # oldest -> newest
        return bars

    async def fetch_raw(
        self, symbol: str, limit: int = 1000, since: Optional[datetime] = None
    ) -> List[OHLCVBar]:
        """Return raw 1m bars (used by the confluence engine)."""
        records = await self._db.fetch(
            """
            SELECT timestamp, open, high, low, close, volume
            FROM market_ohlcv
            WHERE symbol = $1 AND resolution = $2
              AND timestamp >= COALESCE($3, '-infinity'::timestamptz)
            ORDER BY timestamp DESC
            LIMIT $4
            """,
            symbol.upper(),
            _BASE_RESOLUTION,
            since,
            limit,
        )
        bars = [
            OHLCVBar(
                timestamp=_ensure_tz(r["timestamp"]),
                open=float(r["open"]),
                high=float(r["high"]),
                low=float(r["low"]),
                close=float(r["close"]),
                volume=float(r["volume"] or 0.0),
            )
            for r in records
        ]
        bars.reverse()
        return bars

    async def latest_close(self, symbol: str) -> Optional[float]:
        row = await self._db.fetchrow(
            """
            SELECT close FROM market_ohlcv
            WHERE symbol = $1 AND resolution = $2
            ORDER BY timestamp DESC LIMIT 1
            """,
            symbol.upper(),
            _BASE_RESOLUTION,
        )
        return float(row["close"]) if row else None


class SentimentRepository:
    """Read/write access to the ``social_sentiment`` hypertable."""

    def __init__(self, db) -> None:
        self._db = db

    async def insert_records(self, rows: Sequence[tuple]) -> int:
        """Insert classified records, skipping already-seen posts.

        ``rows`` are tuples of ``(timestamp, platform, symbol, external_id,
        author, author_reach, engagement_metrics_json, cleaned_text,
        sentiment_polarity, sentiment_confidence, author_weight)``.
        Returns the number of freshly inserted rows.
        """
        if not rows:
            return 0
        inserted = 0
        for row in rows:
            result = await self._db.execute(
                """
                INSERT INTO social_sentiment (
                    timestamp, platform, symbol, external_id, author, author_reach,
                    engagement_metrics, cleaned_text, sentiment_polarity,
                    sentiment_confidence, author_weight
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
                ON CONFLICT (timestamp, external_id) DO NOTHING
                """,
                *row,
            )
            if result.endswith("INSERT 0 1"):
                inserted += 1
        return inserted

    async def fetch_observations(
        self,
        symbol: str,
        since: Optional[datetime] = None,
        limit: int = 2000,
    ) -> List[SocialObservation]:
        """Return weighted social observations for the confluence engine."""
        records = await self._db.fetch(
            """
            SELECT timestamp, sentiment_polarity, sentiment_confidence, author_weight
            FROM social_sentiment
            WHERE symbol = $1
              AND timestamp >= COALESCE($2, now() - interval '48 hours')
            ORDER BY timestamp DESC
            LIMIT $3
            """,
            symbol.upper(),
            since,
            limit,
        )
        return [
            SocialObservation(
                timestamp=_ensure_tz(r["timestamp"]),
                polarity=float(r["sentiment_polarity"]),
                confidence=float(r["sentiment_confidence"]),
                weight=float(r["author_weight"]),
            )
            for r in records
        ]

    async def hourly_weighted_polarity(
        self,
        symbol: str,
        window_hours: int = 72,
    ) -> List[Tuple[datetime, float]]:
        """Hourly volume-weighted sentiment used for divergence detection."""
        records = await self._db.fetch(
            """
            SELECT time_bucket(interval '1 hour', timestamp) AS bucket,
                   sum(author_weight * sentiment_polarity)
                       / GREATEST(sum(author_weight), 1e-9) AS weighted_polarity
            FROM social_sentiment
            WHERE symbol = $1 AND timestamp >= now() - ($2::int * interval '1 hour')
            GROUP BY bucket
            ORDER BY bucket
            """,
            symbol.upper(),
            window_hours,
        )
        return [(_ensure_tz(r["bucket"]), float(r["weighted_polarity"])) for r in records]

    async def count_recent(self, symbol: str, hours: int = 24) -> int:
        row = await self._db.fetchrow(
            """
            SELECT count(*) AS n FROM social_sentiment
            WHERE symbol = $1 AND timestamp >= now() - ($2::int * interval '1 hour')
            """,
            symbol.upper(),
            hours,
        )
        return int(row["n"]) if row else 0


class DerivativeRepository:
    """Read/write access to the ``derivative_metrics`` hypertable."""

    def __init__(self, db) -> None:
        self._db = db

    async def insert_snapshots(self, rows: Sequence[tuple]) -> None:
        """Upsert derivative snapshots.

        ``rows``: ``(timestamp, symbol, funding_rate, open_interest,
        long_short_ratio)``.
        """
        if not rows:
            return
        await self._db.executemany(
            """
            INSERT INTO derivative_metrics
                (timestamp, symbol, funding_rate, open_interest, long_short_ratio)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (symbol, timestamp) DO UPDATE
            SET funding_rate = COALESCE(EXCLUDED.funding_rate, derivative_metrics.funding_rate),
                open_interest = COALESCE(EXCLUDED.open_interest, derivative_metrics.open_interest),
                long_short_ratio = COALESCE(
                    EXCLUDED.long_short_ratio, derivative_metrics.long_short_ratio
                )
            """,
            rows,
        )

    async def fetch_observations(
        self,
        symbol: str,
        since: Optional[datetime] = None,
        limit: int = 500,
    ) -> List[DerivativeObservation]:
        records = await self._db.fetch(
            """
            SELECT timestamp, funding_rate, open_interest, long_short_ratio
            FROM derivative_metrics
            WHERE symbol = $1
              AND timestamp >= COALESCE($2, now() - interval '48 hours')
            ORDER BY timestamp DESC
            LIMIT $3
            """,
            symbol.upper(),
            since,
            limit,
        )
        observations = [
            DerivativeObservation(
                timestamp=_ensure_tz(r["timestamp"]),
                funding_rate=float(r["funding_rate"]) if r["funding_rate"] is not None else None,
                open_interest=float(r["open_interest"]) if r["open_interest"] is not None else None,
                long_short_ratio=(
                    float(r["long_short_ratio"]) if r["long_short_ratio"] is not None else None
                ),
            )
            for r in records
        ]
        observations.reverse()
        return observations


class SignalRepository:
    """Read/write access to the ``signal_snapshots`` hypertable."""

    def __init__(self, db) -> None:
        self._db = db

    async def insert_snapshot(self, symbol: str, payload: dict) -> None:
        await self._db.execute(
            """
            INSERT INTO signal_snapshots (
                timestamp, symbol, score, technical_component, sentiment_component,
                derivative_component, confidence, regime, breakdown
            )
            VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb)
            """,
            symbol.upper(),
            payload["score"],
            payload["technical"],
            payload["sentiment"],
            payload["derivative"],
            payload["confidence"],
            payload["regime"],
            payload["breakdown_json"],
        )

    async def latest(self, symbol: str) -> Optional[asyncpg.Record]:
        return await self._db.fetchrow(
            "SELECT * FROM signal_snapshots WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1",
            symbol.upper(),
        )
