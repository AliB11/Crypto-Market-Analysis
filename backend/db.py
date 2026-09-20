"""Async PostgreSQL (TimescaleDB) connection management.

The gateway uses a single application-wide ``asyncpg`` pool created during
FastAPI lifespan startup.  Raw SQL is preferred over an ORM for time-series
workloads: TimescaleDB features (``time_bucket``, ``first``/``last``) map
naturally onto SQL and asyncpg gives the lowest possible per-row overhead.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Iterable, Mapping, Optional, Sequence

import asyncpg

from config import Settings, get_settings

logger = logging.getLogger(__name__)


class Database:
    """Thin, typed wrapper around an ``asyncpg`` connection pool."""

    def __init__(self, settings: Optional[Settings] = None) -> None:
        self._settings = settings or get_settings()
        self._pool: Optional[asyncpg.Pool] = None
        self._lock = asyncio.Lock()

    # ----------------------------------------------------------- lifecycle
    async def connect(self, retries: int = 20, delay: float = 1.5) -> asyncpg.Pool:
        """Create the pool, retrying until the database accepts connections."""
        if self._pool is not None:
            return self._pool
        async with self._lock:
            if self._pool is not None:
                return self._pool
            last_error: Exception | None = None
            for attempt in range(1, retries + 1):
                try:
                    self._pool = await asyncpg.create_pool(
                        dsn=self._settings.postgres_dsn,
                        min_size=self._settings.DB_POOL_MIN,
                        max_size=self._settings.DB_POOL_MAX,
                        command_timeout=30.0,
                    )
                    logger.info("PostgreSQL pool established (attempt %d)", attempt)
                    return self._pool
                except Exception as exc:  # pragma: no cover - startup path
                    last_error = exc
                    logger.warning(
                        "PostgreSQL unavailable (attempt %d/%d): %s", attempt, retries, exc
                    )
                    await asyncio.sleep(delay)
            raise RuntimeError(f"Could not connect to PostgreSQL: {last_error}") from last_error

    async def close(self) -> None:
        """Gracefully drain the pool."""
        if self._pool is not None:
            await self._pool.close()
            self._pool = None
            logger.info("PostgreSQL pool closed")

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("Database.connect() must be awaited before use")
        return self._pool

    # -------------------------------------------------------------- helpers
    async def fetch(self, query: str, *args: Any) -> list[asyncpg.Record]:
        return await self.pool.fetch(query, *args)

    async def fetchrow(self, query: str, *args: Any) -> Optional[asyncpg.Record]:
        return await self.pool.fetchrow(query, *args)

    async def execute(self, query: str, *args: Any) -> str:
        return await self.pool.execute(query, *args)

    async def executemany(self, query: str, args: Iterable[Sequence[Any]]) -> None:
        await self.pool.executemany(query, args)


# ---------------------------------------------------------------------------
# Module level singleton used by the API process.  The workers instantiate
# their own ``Database`` to keep process boundaries explicit.
# ---------------------------------------------------------------------------
database = Database()
