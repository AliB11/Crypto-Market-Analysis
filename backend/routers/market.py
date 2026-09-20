"""Market data routes: ``GET /api/v1/market/...``."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Query, Response

from deps import MarketRepository, get_market_repo, validate_symbol
from schemas import Candle, OHLCVResponse, Resolution, SymbolInfo, WatchlistResponse
from config import Settings, get_settings

logger = logging.getLogger("api.market")

router = APIRouter(prefix="/api/v1/market", tags=["market"])

_RESOLUTION_LIMITS = {"5m": 1000, "1h": 1000, "1d": 500}


@router.get(
    "/symbols",
    response_model=WatchlistResponse,
    summary="Monitored watchlist",
    description="Returns the actively ingested symbols with their ccxt-style pair names.",
)
async def list_symbols(settings: Settings = Depends(get_settings)) -> WatchlistResponse:
    return WatchlistResponse(
        quote=settings.QUOTE_ASSET,
        symbols=[
            SymbolInfo(symbol=base.upper(), ccxt_symbol=f"{base.upper()}/{settings.QUOTE_ASSET}")
            for base in settings.SYMBOLS
        ],
    )


@router.get(
    "/ohlcv/{symbol}",
    response_model=OHLCVResponse,
    summary="Historical OHLCV with dynamic bucketing",
    description=(
        "Extracts the historical candle series for a symbol aggregated on the "
        "fly from the 1-minute base grain via TimescaleDB `time_bucket`. "
        "Supported resolutions: 5m, 1h, 1d."
    ),
)
async def get_ohlcv(
    symbol: str = Depends(validate_symbol),
    resolution: Resolution = Query(Resolution.M5, description="Candle bucket size"),
    limit: int = Query(500, ge=10, le=1500, description="Maximum candles returned"),
    market_repo: MarketRepository = Depends(get_market_repo),
) -> OHLCVResponse:
    limit = min(limit, _RESOLUTION_LIMITS[resolution.value])
    bars = await market_repo.fetch_bucketed(symbol, resolution.value, limit=limit)
    candles = [
        Candle(
            time=int(bar.timestamp.timestamp()),
            open=bar.open,
            high=bar.high,
            low=bar.low,
            close=bar.close,
            volume=bar.volume,
        )
        for bar in bars
    ]
    return OHLCVResponse(
        symbol=f"{symbol}USDT",
        resolution=resolution,
        candles=candles,
        count=len(candles),
    )
