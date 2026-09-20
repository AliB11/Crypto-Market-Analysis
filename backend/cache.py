"""Redis connection management and pub/sub helpers.

Redis plays two roles in the platform:

1. **Real-time bus** – ingestion processes publish ticks, sentiment records,
   derivative snapshots and computed signals onto pub/sub channels; the API
   gateway subscribes and fans frames out to WebSocket clients.
2. **Rate-limit storage & short lived caches** – shared across all Uvicorn
   workers so limits and cached composites stay consistent.

``redis.asyncio`` is used everywhere so the whole data plane stays evented.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Mapping, Optional

import redis.asyncio as aioredis

from config import Settings, get_settings

logger = logging.getLogger(__name__)


class RedisBus:
    """Async Redis client wrapper with JSON pub/sub convenience helpers."""

    def __init__(self, settings: Optional[Settings] = None) -> None:
        self._settings = settings or get_settings()
        self._client: Optional[aioredis.Redis] = None

    # ----------------------------------------------------------- lifecycle
    async def connect(self) -> aioredis.Redis:
        if self._client is not None:
            return self._client
        self._client = aioredis.from_url(
            self._settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=5,
            socket_keepalive=True,
            health_check_interval=30,
        )
        await self._client.ping()
        logger.info("Redis connection established (%s)", self._settings.REDIS_URL)
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
            logger.info("Redis connection closed")

    @property
    def client(self) -> aioredis.Redis:
        if self._client is None:
            raise RuntimeError("RedisBus.connect() must be awaited before use")
        return self._client

    # -------------------------------------------------------------- pub/sub
    async def publish_json(self, channel: str, payload: Mapping[str, Any]) -> int:
        """Serialise ``payload`` to JSON and publish onto ``channel``."""
        return await self.client.publish(channel, json.dumps(payload, default=str))

    async def subscribe(self, *channels: str) -> aioredis.client.PubSub:
        pubsub = self.client.pubsub()
        await pubsub.subscribe(*channels)
        return pubsub


# Module level singleton for the API process.
redis_bus = RedisBus()


async def safe_next_message(pubsub: aioredis.client.PubSub) -> Optional[dict[str, Any]]:
    """Await the next pub/sub message, returning ``None`` on timeout/cancel.

    Keeps WebSocket relay loops responsive to disconnects while never letting
    a Redis hiccup crash the client connection.
    """
    try:
        message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
    except asyncio.CancelledError:  # pragma: no cover - normal shutdown path
        raise
    except Exception as exc:
        logger.warning("Redis pub/sub read failed: %s", exc)
        await asyncio.sleep(0.5)
        return None
    if message is None or message.get("type") != "message":
        return None
    try:
        return json.loads(message["data"])
    except (TypeError, ValueError):
        logger.warning("Dropping malformed pub/sub payload on %s", message.get("channel"))
        return None
