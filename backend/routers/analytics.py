"""Analytics routes: ``GET /api/v1/analytics/composite-score/{symbol}``."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query

from config import Settings, get_settings
from deps import (
    DerivativeRepository,
    MarketRepository,
    QuantitativeEngine,
    SentimentRepository,
    get_derivative_repo,
    get_engine,
    get_market_repo,
    get_sentiment_repo,
    validate_symbol,
)
from schemas import (
    ConfluenceScoreResponse,
    DerivativeBreakdown,
    DivergenceSignal,
    SentimentBreakdown,
    TechnicalBreakdown,
)

logger = logging.getLogger("api.analytics")

router = APIRouter(prefix="/api/v1/analytics", tags=["analytics"])


@router.get(
    "/composite-score/{symbol}",
    response_model=ConfluenceScoreResponse,
    summary="Multi-factor confluence score",
    description=(
        "Computes the bounded composite confluence score in [-100, +100] from "
        "three weighted components: technical momentum (35%), sentiment "
        "velocity (35%) and derivative dynamics (30%), including the full "
        "breakdown of every sub-indicator and data-quality warnings."
    ),
)
async def get_composite_score(
    symbol: str = Depends(validate_symbol),
    lookback_hours: int = Query(48, ge=6, le=168, description="Sentiment lookback window"),
    market_repo: MarketRepository = Depends(get_market_repo),
    sentiment_repo: SentimentRepository = Depends(get_sentiment_repo),
    derivative_repo: DerivativeRepository = Depends(get_derivative_repo),
    engine: QuantitativeEngine = Depends(get_engine),
    settings: Settings = Depends(get_settings),
) -> ConfluenceScoreResponse:
    now = datetime.now(timezone.utc)
    since = now - timedelta(hours=lookback_hours)

    bars = await market_repo.fetch_raw(symbol, limit=1500, since=now - timedelta(days=7))
    social = await sentiment_repo.fetch_observations(symbol, since=since)
    derivatives = await derivative_repo.fetch_observations(symbol, since=since)

    result = engine.compute_confluence(
        symbol,
        bars,
        social,
        derivatives,
        low_liquidity_volume_threshold=settings.LOW_LIQUIDITY_VOLUME_THRESHOLD,
        volatility_window=settings.VOLATILITY_WINDOW_DAYS,
        now=now,
    )

    technical = result.technical
    sentiment = result.sentiment
    derivative = result.derivative

    divergence_dto = None
    if sentiment.divergence is not None:
        divergence_dto = DivergenceSignal(
            kind=sentiment.divergence.kind,
            detected_at=sentiment.divergence.detected_at,
            price_pivot_time=sentiment.divergence.price_pivot_time,
            price_from=sentiment.divergence.price_from,
            price_to=sentiment.divergence.price_to,
            sentiment_from=sentiment.divergence.sentiment_from,
            sentiment_to=sentiment.divergence.sentiment_to,
            strength=sentiment.divergence.strength,
        )

    return ConfluenceScoreResponse(
        symbol=f"{symbol}USDT",
        score=result.score,
        regime=result.regime,
        confidence=result.confidence,
        technical=result.technical.normalised,
        sentiment=result.sentiment.normalised,
        derivative=result.derivative.normalised,
        technical_detail=TechnicalBreakdown(
            rsi=technical.rsi,
            macd_line=technical.macd.macd_line if technical.macd else None,
            macd_signal=technical.macd.signal_line if technical.macd else None,
            macd_histogram=technical.macd.histogram if technical.macd else None,
            historical_volatility_30d=technical.historical_volatility,
            last_close=technical.last_close,
        ),
        sentiment_detail=SentimentBreakdown(
            weighted_polarity=sentiment.weighted_polarity,
            velocity=sentiment.velocity,
            divergence=divergence_dto,
            sample_size=sentiment.sample_size,
        ),
        derivative_detail=DerivativeBreakdown(
            funding_rate=derivative.funding_rate,
            funding_deviation=derivative.funding_deviation,
            open_interest=derivative.open_interest,
            open_interest_delta_24h_pct=derivative.open_interest_delta_pct,
            long_short_ratio=derivative.long_short_ratio,
        ),
        warnings=list(result.warnings),
        computed_at=result.computed_at,
    )
