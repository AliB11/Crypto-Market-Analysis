"""Centralised, typed application configuration.

Every runtime knob of the platform is expressed here as an environment
driven setting (12-factor style).  Both the FastAPI gateway, the Celery
analytics worker and the ingestion processes import this module, guaranteeing
a single source of truth for configuration across all services.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated, List, Sequence

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """Strongly typed settings loaded from environment variables / `.env`."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ------------------------------------------------------------------ core
    ENVIRONMENT: str = Field(default="development", description="development|staging|production")
    LOG_LEVEL: str = Field(default="INFO", description="Root log level (DEBUG|INFO|WARNING|ERROR)")
    SERVICE_NAME: str = "crypto-intel-terminal"
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 8000
    API_WORKERS: int = 2

    # -------------------------------------------------------------- database
    POSTGRES_HOST: str = "localhost"
    POSTGRES_PORT: int = 5432
    POSTGRES_USER: str = "crypto"
    POSTGRES_PASSWORD: str = "crypto"
    POSTGRES_DB: str = "crypto_intel"
    DB_POOL_MIN: int = 2
    DB_POOL_MAX: int = 10

    # ----------------------------------------------------------------- redis
    REDIS_URL: str = "redis://localhost:6379/0"

    # ------------------------------------------------------------------- api
    CORS_ORIGINS: Annotated[List[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:3000"],
        description="Comma separated list of allowed CORS origins.",
    )
    RATELIMIT_ENABLED: bool = True
    RATELIMIT_DEFAULT: str = "120/minute"

    # ----------------------------------------------------------- watchlists
    SYMBOLS: Annotated[List[str], NoDecode] = Field(
        default_factory=lambda: ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA"],
        description="Comma separated base-asset watchlist, e.g. BTC,ETH,SOL.",
    )
    QUOTE_ASSET: str = "USDT"
    EXCHANGE_ID: str = "binance"

    # ------------------------------------------------------- ingestion timers
    MARKET_FEED_RESOLUTION: str = "1m"
    DERIVATIVE_POLL_SECONDS: int = 60
    SOCIAL_POLL_SECONDS: int = 90
    SOCIAL_LOOKBACK_POSTS: int = 80

    # ------------------------------------------------------------- NLP / ML
    SENTIMENT_MODEL_ID: str = "cardiffnlp/twitter-roberta-base-sentiment-latest"
    SENTIMENT_MODEL_FALLBACK_ID: str = "ProsusAI/finbert"
    NLP_DEVICE: str = Field(default="cpu", description="cpu|cuda|mps")
    NLP_BATCH_SIZE: int = 32
    SOCIAL_ALERT_MIN_CONFIDENCE: float = 0.65
    SOCIAL_ALERT_MIN_ABS_POLARITY: float = 0.45

    # ----------------------------------------------------------- quant engine
    RSI_PERIOD: int = 14
    MACD_FAST: int = 12
    MACD_SLOW: int = 26
    MACD_SIGNAL: int = 9
    VOLATILITY_WINDOW_DAYS: int = 30
    FUNDING_BASELINE: float = 0.0
    FUNDING_SCALE: float = 0.0005  # 0.05% per 8h saturates the derivative factor
    LOW_LIQUIDITY_VOLUME_THRESHOLD: float = 1_000.0  # quote volume per 1m candle

    # --------------------------------------------------- redis pub/sub channels
    CHANNEL_TICKS: str = "ticks"
    CHANNEL_SIGNALS: str = "signals"
    CHANNEL_DERIVATIVES: str = "derivatives"
    CHANNEL_SENTIMENT: str = "sentiment_stream"

    # -------------------------------------------------------------- retention
    OHLCV_RETENTION_DAYS: int = 180
    SENTIMENT_RETENTION_DAYS: int = 180
    DERIVATIVE_RETENTION_DAYS: int = 180
    SIGNAL_RETENTION_DAYS: int = 365

    # ------------------------------------------------------------ credentials
    TWITTER_BEARER_TOKEN: str = ""
    REDDIT_CLIENT_ID: str = ""
    REDDIT_CLIENT_SECRET: str = ""
    REDDIT_USER_AGENT: str = "crypto-intel-terminal/1.0 (research)"

    @field_validator("SYMBOLS", "CORS_ORIGINS", mode="before")
    @classmethod
    def _split_csv(cls, value: object) -> object:
        """Accept ``"BTC,ETH"`` style input in addition to native lists."""
        if isinstance(value, str) and value.strip():
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @property
    def postgres_dsn(self) -> str:
        """Asyncpg-compatible DSN for the TimescaleDB instance."""
        return (
            f"postgresql://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    @property
    def ccxt_symbols(self) -> List[str]:
        """Watchlist mapped to unified ccxt symbols, e.g. ``['BTC/USDT', ...]``."""
        return [f"{base.upper()}/{self.QUOTE_ASSET.upper()}" for base in self.SYMBOLS]

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() == "production"

    def allow_cors(self, origins: Sequence[str] | None = None) -> None:
        """Extend allowed CORS origins at runtime (used by tooling/tests)."""
        for origin in origins or ():
            if origin not in self.CORS_ORIGINS:
                self.CORS_ORIGINS.append(origin)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings accessor (safe to call from every request handler)."""
    return Settings()
