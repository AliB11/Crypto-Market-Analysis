"""Sentiment routes: ``GET /api/v1/sentiment/divergence/{symbol}``."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query

from config import Settings, get_settings
from deps import (
    MarketRepository,
    SentimentRepository,
    get_market_repo,
    get_sentiment_repo,
    validate_symbol,
)
from schemas import DivergenceResponse, DivergenceSignal
from services.quantitative import QuantitativeEngine

logger = logging.getLogger("api.sentiment")

router = APIRouter(prefix="/api/v1/sentiment", tags=["sentiment"])


@router.get(
    "/divergence/{symbol}",
    response_model=DivergenceResponse,
    summary="Sentiment-to-price divergence signals",
    description=(
        "Detects automated bullish/bearish divergences between price pivots "
        "and hourly volume-weighted social sentiment over the requested "
        "window: price lower low vs sentiment higher low (bullish) and price "
        "higher high vs sentiment lower high (bearish)."
    ),
)
async def get_divergence(
    symbol: str = Depends(validate_symbol),
    window_hours: int = Query(72, ge=12, le=336, description="Lookback window in hours"),
    market_repo: MarketRepository = Depends(get_market_repo),
    sentiment_repo: SentimentRepository = Depends(get_sentiment_repo),
    settings: Settings = Depends(get_settings),
) -> DivergenceResponse:
    now = datetime.now(timezone.utc)
    since = now - timedelta(hours=window_hours)

    bars = await market_repo.fetch_bucketed(symbol, "1h", limit=window_hours, since=since)
    sentiment_hourly = await sentiment_repo.hourly_weighted_polarity(symbol, window_hours)

    price_series = [(bar.timestamp, bar.close) for bar in bars]

    signals: list[DivergenceSignal] = []
    # Scan several pivot lookbacks to catch both coarse and fine structure.
    for pivot_lookback in (6, 4, 3):
        detection = QuantitativeEngine.detect_divergence(
            price_series, sentiment_hourly, pivot_lookback=pivot_lookback, now=now
        )
        if detection is None:
            continue
        signals.append(
            DivergenceSignal(
                kind=detection.kind,
                detected_at=detection.detected_at,
                price_pivot_time=detection.price_pivot_time,
                price_from=detection.price_from,
                price_to=detection.price_to,
                sentiment_from=detection.sentiment_from,
                sentiment_to=detection.sentiment_to,
                strength=detection.strength,
            )
        )
        if len(signals) >= 2:
            break

    return DivergenceResponse(symbol=f"{symbol}USDT", window_hours=window_hours, signals=signals)
