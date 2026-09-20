"""Pydantic v2 API schemas (request / response contracts).

These models are the single wire-format contract between the FastAPI gateway,
the Celery workers and the Next.js client.  Everything that crosses a process
boundary is versioned and validated here.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


# --------------------------------------------------------------------------- enums
class Resolution(str, Enum):
    """Supported bucketing resolutions for OHLCV queries."""

    M5 = "5m"
    H1 = "1h"
    D1 = "1d"


class SentimentPlatform(str, Enum):
    TWITTER = "twitter"
    REDDIT = "reddit"


class DivergenceKind(str, Enum):
    BULLISH = "bullish"
    BEARISH = "bearish"


class MarketRegime(str, Enum):
    RISK_ON = "risk_on"
    NEUTRAL = "neutral"
    RISK_OFF = "risk_off"


class WSChannel(str, Enum):
    """Multiplexed WebSocket frame channels."""

    PRICE = "price"
    SIGNAL = "signal"
    SENTIMENT = "sentiment"
    DERIVATIVES = "derivatives"
    STATUS = "status"


# --------------------------------------------------------------------- market DTOs
class Candle(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {"time": 1710000000, "open": 51000.0}})

    time: int = Field(..., description="UNIX timestamp (seconds) of the bucket open", ge=0)
    open: float = Field(..., description="Open price")
    high: float = Field(..., description="High price")
    low: float = Field(..., description="Low price")
    close: float = Field(..., description="Close price")
    volume: float = Field(..., ge=0.0, description="Traded volume in quote asset")


class OHLCVResponse(BaseModel):
    symbol: str = Field(..., description="Trading pair, e.g. 'BTCUSDT'")
    resolution: Resolution
    candles: List[Candle]
    count: int = Field(..., description="Number of returned candles")


# ------------------------------------------------------------------ sentiment DTOs
class SentimentRecord(BaseModel):
    timestamp: datetime
    platform: SentimentPlatform
    symbol: str
    author: str
    author_reach: int = 0
    engagement_metrics: Dict[str, float] = Field(default_factory=dict)
    cleaned_text: str
    sentiment_polarity: float = Field(..., ge=-1.0, le=1.0)
    sentiment_confidence: float = Field(..., ge=0.0, le=1.0)


class DivergenceSignal(BaseModel):
    kind: DivergenceKind
    detected_at: datetime
    price_pivot_time: datetime
    price_from: float
    price_to: float
    sentiment_from: float
    sentiment_to: float
    strength: float = Field(..., ge=0.0, le=1.0, description="Normalised signal strength")


class DivergenceResponse(BaseModel):
    symbol: str
    window_hours: int
    signals: List[DivergenceSignal]


# ------------------------------------------------------------------ analytics DTOs
class TechnicalBreakdown(BaseModel):
    rsi: Optional[float] = Field(None, description="14-period RSI (0-100)")
    macd_line: Optional[float] = None
    macd_signal: Optional[float] = None
    macd_histogram: Optional[float] = None
    historical_volatility_30d: Optional[float] = Field(
        None, description="Annualised 30-day log-return volatility"
    )
    last_close: Optional[float] = None


class SentimentBreakdown(BaseModel):
    weighted_polarity: Optional[float] = Field(
        None, ge=-1.0, le=1.0, description="Volume/reach weighted mean polarity"
    )
    velocity: Optional[float] = Field(
        None, description="First derivative of weighted sentiment across the window"
    )
    divergence: Optional[DivergenceSignal] = None
    sample_size: int = 0


class DerivativeBreakdown(BaseModel):
    funding_rate: Optional[float] = Field(None, description="Perpetual funding rate per 8h")
    funding_deviation: Optional[float] = Field(None, description="Deviation from baseline 0")
    open_interest: Optional[float] = None
    open_interest_delta_24h_pct: Optional[float] = None
    long_short_ratio: Optional[float] = None


class ConfluenceScoreResponse(BaseModel):
    symbol: str
    score: float = Field(..., ge=-100.0, le=100.0, description="Composite confluence score")
    regime: MarketRegime
    confidence: float = Field(..., ge=0.0, le=1.0)
    technical: float = Field(..., ge=-1.0, le=1.0, description="Technical component (35% weight)")
    sentiment: float = Field(..., ge=-1.0, le=1.0, description="Sentiment component (35% weight)")
    derivative: float = Field(..., ge=-1.0, le=1.0, description="Derivative component (30% weight)")
    technical_detail: TechnicalBreakdown
    sentiment_detail: SentimentBreakdown
    derivative_detail: DerivativeBreakdown
    warnings: List[str] = Field(default_factory=list)
    computed_at: datetime


# ------------------------------------------------------------------ websocket DTOs
class WSFrame(BaseModel):
    """Envelope for every message pushed down ``/ws/live/{symbol}``."""

    channel: WSChannel
    type: str = Field(..., description="Frame discriminator within the channel")
    symbol: str
    data: Dict[str, Any]
    server_ts: datetime


class SymbolInfo(BaseModel):
    symbol: str
    ccxt_symbol: str


class WatchlistResponse(BaseModel):
    quote: str
    symbols: List[SymbolInfo]


# ------------------------------------------------------------------------ errors
class ErrorResponse(BaseModel):
    error: str
    detail: str
    request_id: Optional[str] = None
