"""Celery tasks: quantitative recomputation and retention enforcement.

Tasks are declared ``async`` and executed on the event loop pool
(``--pool=asyncio`` from ``celery-aio-pool``).  Each task owns its own
database/Redis connections because Celery workers are separate processes
from the API gateway – nothing is shared except the backing services.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict

from cache import RedisBus
from config import get_settings
from db import Database
from repositories import DerivativeRepository, MarketRepository, SentimentRepository, SignalRepository
from services.quantitative import QuantitativeEngine
from workers.celery_app import celery_app

logger = logging.getLogger("worker.tasks")


@celery_app.task(
    name="workers.tasks.refresh_confluence",
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_backoff_max=300,
    max_retries=3,
)
async def refresh_confluence() -> Dict[str, Any]:
    """Recompute confluence scores for the full watchlist.

    For every symbol: load recent 1m bars, weighted social observations and
    derivative snapshots; run :meth:`QuantitativeEngine.compute_confluence`;
    persist a snapshot row and broadcast the result on Redis channel
    ``signals:{SYMBOL}`` together with a 5-minute ``latest:signal:{SYMBOL}``
    cache used by the WebSocket gateway for instant connect snapshots.
    """
    settings = get_settings()
    db = Database(settings)
    bus = RedisBus(settings)
    engine = QuantitativeEngine()
    results: Dict[str, Any] = {}

    try:
        await db.connect()
        await bus.connect()
        market_repo = MarketRepository(db)
        sentiment_repo = SentimentRepository(db)
        derivative_repo = DerivativeRepository(db)
        signal_repo = SignalRepository(db)

        now = datetime.now(timezone.utc)
        for base in settings.SYMBOLS:
            try:
                bars = await market_repo.fetch_raw(base, limit=1500, since=now - timedelta(days=7))
                social = await sentiment_repo.fetch_observations(
                    base, since=now - timedelta(hours=48)
                )
                derivatives = await derivative_repo.fetch_observations(
                    base, since=now - timedelta(hours=48)
                )
                confluence = engine.compute_confluence(
                    base,
                    bars,
                    social,
                    derivatives,
                    low_liquidity_volume_threshold=settings.LOW_LIQUIDITY_VOLUME_THRESHOLD,
                    volatility_window=settings.VOLATILITY_WINDOW_DAYS,
                    now=now,
                )
                payload = _serialise_confluence(confluence)
                await signal_repo.insert_snapshot(base, payload)
                await bus.publish_json(
                    f"{settings.CHANNEL_SIGNALS}:{base}",
                    {
                        "channel": "signal",
                        "type": "confluence",
                        "symbol": base,
                        "data": payload,
                    },
                )
                await bus.client.set(
                    f"latest:signal:{base}", json.dumps(payload), ex=300
                )
                results[base] = {"score": round(confluence.score, 2), "regime": confluence.regime}
            except Exception as exc:  # one bad symbol never kills the round
                logger.exception("confluence refresh failed for %s: %s", base, exc)
                results[base] = {"error": str(exc)}
        logger.info("confluence refresh complete: %s", results)
        return results
    finally:
        await bus.close()
        await db.close()


@celery_app.task(name="workers.tasks.enforce_retention")
async def enforce_retention() -> Dict[str, int]:
    """Drop hypertable chunks beyond the configured retention windows.

    Uses TimescaleDB ``drop_chunks`` which is metadata-cheap and does not
    bloat the WAL the way mass ``DELETE`` would.
    """
    settings = get_settings()
    db = Database(settings)
    dropped = 0
    try:
        await db.connect()
        table_windows = {
            "market_ohlcv": settings.OHLCV_RETENTION_DAYS,
            "social_sentiment": settings.SENTIMENT_RETENTION_DAYS,
            "derivative_metrics": settings.DERIVATIVE_RETENTION_DAYS,
            "signal_snapshots": settings.SIGNAL_RETENTION_DAYS,
        }
        for table, days in table_windows.items():
            await db.execute(
                "SELECT drop_chunks($1::regclass, INTERVAL '1 second' * $2)",
                table,
                days * 86400,
            )
        dropped = len(table_windows)
        logger.info("retention enforced on %d hypertables", dropped)
        return {"tables": dropped}
    finally:
        await db.close()


def _serialise_confluence(confluence) -> Dict[str, Any]:
    """Flatten a :class:`ConfluenceResult` for Redis/JSON transport."""

    def _round(value, digits=6):
        return round(value, digits) if isinstance(value, (int, float)) else value

    technical = confluence.technical
    sentiment = confluence.sentiment
    derivative = confluence.derivative
    return {
        "symbol": confluence.symbol,
        "score": _round(confluence.score, 2),
        "regime": confluence.regime,
        "confidence": _round(confluence.confidence, 4),
        "components": {
            "technical": _round(technical.normalised, 4),
            "sentiment": _round(sentiment.normalised, 4),
            "derivative": _round(derivative.normalised, 4),
        },
        "technical": {
            "rsi": _round(technical.rsi, 2),
            "macd_line": _round(technical.macd.macd_line) if technical.macd else None,
            "macd_signal": _round(technical.macd.signal_line) if technical.macd else None,
            "macd_histogram": _round(technical.macd.histogram) if technical.macd else None,
            "historical_volatility_30d": _round(technical.historical_volatility, 4),
            "last_close": _round(technical.last_close),
        },
        "sentiment": {
            "weighted_polarity": _round(sentiment.weighted_polarity, 4),
            "velocity": _round(sentiment.velocity, 4),
            "divergence": sentiment.divergence.as_dict() if sentiment.divergence else None,
            "sample_size": sentiment.sample_size,
        },
        "derivative": {
            "funding_rate": _round(derivative.funding_rate, 8),
            "funding_deviation": _round(derivative.funding_deviation, 4),
            "open_interest": _round(derivative.open_interest, 2),
            "open_interest_delta_24h_pct": _round(derivative.open_interest_delta_pct, 4),
            "long_short_ratio": _round(derivative.long_short_ratio, 4),
        },
        "warnings": list(confluence.warnings),
        "computed_at": confluence.computed_at.isoformat(),
    }
