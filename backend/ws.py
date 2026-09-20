"""WebSocket gateway: multiplexed real-time streaming (Step 4).

``WS /ws/live/{symbol}`` subscribes the connected client to a *composite*
stream assembled from four Redis pub/sub channels:

======================  ======================================================
Channel                 Payload
======================  ======================================================
``ticks:{SYMBOL}``      live candle / price-tick updates (market feed)
``signals:{SYMBOL}``    recomputed confluence scores (analytics worker)
``derivatives:{SYMBOL}`` funding / open-interest / long-short updates
``sentiment_stream``    global social alerts, filtered server-side by symbol
======================  ======================================================

Frames are enveloped as ``{"channel": ..., "type": ..., "symbol": ...,
"data": ..., "server_ts": ...}`` so a single browser socket renders price,
signals and social alerts without multiplexing logic client-side.

Every client gets its own PubSub connection from the shared Redis pool; on
disconnect the subscription is always released (``finally`` block) so the
gateway never leaks Redis subscriber connections.

An initial snapshot frame (latest close + latest cached signal) is pushed on
connect so the UI can render instantly before the first live event arrives.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional

from fastapi import WebSocket, WebSocketDisconnect

from cache import RedisBus, safe_next_message
from config import Settings, get_settings

logger = logging.getLogger("api.ws")


class StreamHub:
    """Abstraction over the Redis pub/sub fabric.

    Exists as a class so the test suite can substitute an in-memory fake
    (see ``backend/tests/conftest.py``) without touching Redis.
    """

    def __init__(self, bus: RedisBus, settings: Settings) -> None:
        self._bus = bus
        self._settings = settings

    def channels_for(self, symbol: str) -> List[str]:
        s = self._settings
        return [
            f"{s.CHANNEL_TICKS}:{symbol}",
            f"{s.CHANNEL_SIGNALS}:{symbol}",
            f"{s.CHANNEL_DERIVATIVES}:{symbol}",
            s.CHANNEL_SENTIMENT,
        ]

    async def stream(self, symbol: str) -> AsyncIterator[Dict[str, Any]]:
        """Yield parsed JSON payloads from the multiplexed channels."""
        pubsub = await self._bus.subscribe(*self.channels_for(symbol))
        try:
            while True:
                message = await safe_next_message(pubsub)
                if message is not None:
                    yield message
        finally:
            with contextlib.suppress(Exception):
                await pubsub.unsubscribe()
                await pubsub.aclose()


def _frame(channel: str, frame_type: str, symbol: str, data: Dict[str, Any]) -> str:
    return json.dumps(
        {
            "channel": channel,
            "type": frame_type,
            "symbol": symbol,
            "data": data,
            "server_ts": datetime.now(timezone.utc).isoformat(),
        },
        default=str,
    )


async def _initial_snapshot(websocket: WebSocket, symbol: str, settings: Settings) -> None:
    """Push a best-effort snapshot so the terminal paints immediately."""
    try:
        bus: RedisBus = websocket.app.state.redis_bus
        cached = await bus.client.get(f"latest:signal:{symbol}")
        snapshot: Dict[str, Any] = {"symbol": symbol}
        if cached:
            snapshot["signal"] = json.loads(cached)
        await websocket.send_text(_frame("status", "snapshot", symbol, snapshot))
    except Exception as exc:  # pragma: no cover - snapshot is best-effort
        logger.debug("snapshot payload unavailable for %s: %s", symbol, exc)


async def live_terminal_endpoint(
    websocket: WebSocket,
    symbol: str,
    settings: Settings = None,  # injected by route factory
) -> None:
    """Route handler backing ``WS /ws/live/{symbol}``."""
    await websocket.accept()
    normalized = symbol.upper()

    hub: StreamHub = websocket.app.state.stream_hub
    settings = settings or get_settings()

    await _initial_snapshot(websocket, normalized, settings)

    # Gentle keep-alive: detect dead browser sockets behind proxies.
    async def ping_loop() -> None:
        while True:
            await asyncio.sleep(20.0)
            await websocket.send_text(_frame("status", "ping", normalized, {}))

    ping_task = asyncio.create_task(ping_loop())
    queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue(maxsize=512)

    async def relay() -> None:
        try:
            async for message in hub.stream(normalized):
                await queue.put(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("stream relay for %s ended: %s", normalized, exc)

    relay_task = asyncio.create_task(relay())

    def matches_symbol(message: Dict[str, Any]) -> bool:
        msg_symbol = str(message.get("symbol", "")).upper()
        channel = str(message.get("channel", ""))
        # Global sentiment stream is filtered by symbol server-side.
        return channel != "sentiment" or msg_symbol == normalized

    try:
        while True:
            try:
                message = await asyncio.wait_for(queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                continue
            if not matches_symbol(message):
                continue
            frame_type = message.get("type", "update")
            channel = message.get("channel", "price")
            data = message.get("data", message)
            await websocket.send_text(_frame(channel, frame_type, normalized, data))
    except WebSocketDisconnect:
        logger.info("client disconnected from /ws/live/%s", normalized)
    except Exception as exc:
        logger.warning("websocket error for %s: %s", normalized, exc)
    finally:
        ping_task.cancel()
        relay_task.cancel()
        for task in (ping_task, relay_task):
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task


def register_ws_routes(app) -> None:
    """Attach the WebSocket route to the FastAPI application."""

    @app.websocket("/ws/live/{symbol}")
    async def _live(websocket: WebSocket, symbol: str) -> None:  # pragma: no cover
        settings = get_settings()
        normalized = symbol.upper()
        if normalized not in {s.upper() for s in settings.SYMBOLS}:
            await websocket.accept()
            await websocket.send_text(
                _frame("status", "error", normalized, {"detail": "unknown symbol"})
            )
            await websocket.close(code=4404)
            return
        await live_terminal_endpoint(websocket, symbol, settings)
