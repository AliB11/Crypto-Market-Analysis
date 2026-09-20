"""FastAPI dependency providers.

Every route resolves its collaborators (repositories, engines, settings)
through these providers.  The pytest suite overrides them with in-memory
fakes via ``app.dependency_overrides`` – the production code path never
branches on ``testing`` flags.
"""

from __future__ import annotations

from typing import Optional

from fastapi import Depends, HTTPException, Request, status

from config import Settings, get_settings
from db import Database, database
from repositories import (
    DerivativeRepository,
    MarketRepository,
    SentimentRepository,
    SignalRepository,
)
from services.quantitative import QuantitativeEngine

__all__ = [
    "Database",
    "MarketRepository",
    "SentimentRepository",
    "DerivativeRepository",
    "SignalRepository",
    "QuantitativeEngine",
    "get_settings",
    "get_database",
    "get_market_repo",
    "get_sentiment_repo",
    "get_derivative_repo",
    "get_signal_repo",
    "get_engine",
    "validate_symbol",
    "SymbolNotFoundError",
]



class SymbolNotFoundError(HTTPException):
    """Raised when a requested symbol is not part of the watchlist."""

    def __init__(self, symbol: str) -> None:
        super().__init__(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Symbol '{symbol}' is not part of the monitored watchlist.",
        )


def get_database(request: Request) -> Database:
    """Return the application-scoped asyncpg wrapper."""
    return getattr(request.app.state, "database", database)


def get_market_repo(db: Database = Depends(get_database)) -> MarketRepository:
    return MarketRepository(db)


def get_sentiment_repo(db: Database = Depends(get_database)) -> SentimentRepository:
    return SentimentRepository(db)


def get_derivative_repo(db: Database = Depends(get_database)) -> DerivativeRepository:
    return DerivativeRepository(db)


def get_signal_repo(db: Database = Depends(get_database)) -> SignalRepository:
    return SignalRepository(db)


def get_engine() -> QuantitativeEngine:
    return QuantitativeEngine()


def validate_symbol(
    symbol: str,
    settings: Settings = Depends(get_settings),
) -> str:
    """Reject symbols outside the configured watchlist early (404)."""
    normalized = symbol.upper().replace("-", "").replace("/", "")
    if normalized not in {s.upper() for s in settings.SYMBOLS}:
        raise SymbolNotFoundError(normalized)
    return normalized


def get_optional_symbol(symbol: Optional[str]) -> Optional[str]:
    return symbol.upper() if symbol else None
