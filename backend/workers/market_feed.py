"""Market data ingestion service (Step 2.2).

Connects to exchange WebSocket streams via **ccxt.pro** (Binance public
WebSockets), ingests 1-minute kline candles plus mark-price / ticker
updates, buffers them and commits batches to the ``market_ohlcv`` and
``derivative_metrics`` hypertables while broadcasting live ticks onto Redis
pub/sub for the WebSocket gateway.

Architecture
------------
* One async task per watchlist symbol consuming ``watch_ohlcv`` /
  ``watch_ticker`` streams (ccxt.pro multiplexes the underlying WS).
* A derivative poller hits REST endpoints (funding rate, open interest,
  global long/short ratio) every ``DERIVATIVE_POLL_SECONDS`` and commits to
  ``derivative_metrics`` + publishes ``derivatives:{SYMBOL}`` frames.
* A batch committer flushes buffered candle upserts every few seconds so a
  single INSERT ... ON CONFLICT round-trip covers dozens of ticks.
* On startup a REST backfill (``fetch_ohlcv``) seeds recent history so the
  terminal has a chart immediately after a cold start.

Resilience: every stream task runs inside a supervised loop with
exponential backoff (1s -> 60s) – exchange disconnects, rate limits and
container restarts never kill the process.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import os
import signal
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx

from cache import RedisBus
from config import Settings, get_settings
from db import Database
from repositories import DerivativeRepository, MarketRepository

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-8s %(name)s :: %(message)s",
)
logger = logging.getLogger("worker.market_feed")

SYMBOL_COMPONENT_ALIASES: Dict[str, str] = {
    "BTC": "BTCUSDT",
    "ETH": "ETHUSDT",
    "SOL": "SOLUSDT",
    "BNB": "BNBUSDT",
    "XRP": "XRPUSDT",
    "DOGE": "DOGEUSDT",
    "ADA": "ADAUSDT",
}


@dataclass
class BufferedBar:
    """Latest state of a single in-flight 1m candle."""

    timestamp: datetime
    symbol: str
    open: float
    high: float
    low: float
    close: float
    volume: float


class MarketFeedService:
    """Streams exchange market data into TimescaleDB and Redis."""

    def __init__(self, settings: Optional[Settings] = None) -> None:
        self.settings = settings or get_settings()
        self.db = Database(self.settings)
        self.bus = RedisBus(self.settings)
        self.market_repo: Optional[MarketRepository] = None
        self.derivative_repo: Optional[DerivativeRepository] = None
        self.exchange: Any = None
        self._bars: Dict[str, BufferedBar] = {}
        self._shutdown = asyncio.Event()
        self._http = httpx.AsyncClient(timeout=15.0)

    # ------------------------------------------------------------- lifecycle
    async def start(self) -> None:
        """Supervised entrypoint – runs until SIGTERM/SIGINT."""
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            with contextlib.suppress(NotImplementedError):
                loop.add_signal_handler(sig, self._shutdown.set)

        await self.db.connect()
        await self.bus.connect()
        self.market_repo = MarketRepository(self.db)
        self.derivative_repo = DerivativeRepository(self.db)
        self.exchange = self._build_exchange()

        symbols = self.settings.ccxt_symbols
        logger.info("market feed starting for %s via %s", symbols, self.settings.EXCHANGE_ID)

        tasks: List[asyncio.Task] = [
            asyncio.create_task(self._supervise(f"backfill", self._backfill_history, symbols)),
            asyncio.create_task(self._supervise("committer", self._commit_loop)),
            asyncio.create_task(self._supervise("derivatives", self._derivative_loop, symbols)),
        ]
        for ccxt_symbol in symbols:
            tasks.append(
                asyncio.create_task(
                    self._supervise(
                        f"ohlcv:{ccxt_symbol}", self._ohlcv_stream, ccxt_symbol
                    )
                )
            )
            tasks.append(
                asyncio.create_task(
                    self._supervise(f"ticker:{ccxt_symbol}", self._ticker_stream, ccxt_symbol)
                )
            )

        await self._shutdown.wait()
        logger.info("shutdown signal received – draining")
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self._http.aclose()
        with contextlib.suppress(Exception):
            await self.exchange.close()
        await self.bus.close()
        await self.db.close()
        logger.info("market feed stopped")

    def _build_exchange(self) -> Any:
        """Create the ccxt.pro async exchange (enableRateLimit on)."""
        import ccxt.pro as ccxtpro  # lazy: keeps module import light

        exchange_class = getattr(ccxtpro, self.settings.EXCHANGE_ID)
        exchange = exchange_class({"enableRateLimit": True, "newUpdates": True})
        return exchange

    # ------------------------------------------------------------ supervision
    async def _supervise(self, name: str, factory, *args) -> None:
        """Run ``factory`` forever with exponential backoff (1s -> 60s)."""
        backoff = 1.0
        while not self._shutdown.is_set():
            try:
                await factory(*args)
                if not self._shutdown.is_set():
                    raise RuntimeError(f"{name} stream ended unexpectedly")
            except asyncio.CancelledError:
                return
            except Exception as exc:
                logger.warning("%s failed: %s – retrying in %.0fs", name, exc, backoff)
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self._shutdown.wait(), timeout=backoff)
                backoff = min(backoff * 2, 60.0)

    # -------------------------------------------------------------- backfill
    async def _backfill_history(self, symbols: List[str]) -> None:
        """Seed recent 1m history (default: last 6 hours) via REST."""
        limit = 360
        rows: List[tuple] = []
        for ccxt_symbol in symbols:
            try:
                candles = await self.exchange.fetch_ohlcv(ccxt_symbol, "1m", limit=limit)
                base = ccxt_symbol.split("/")[0]
                for candle in candles:
                    rows.append(
                        (
                            datetime.fromtimestamp(candle[0] / 1000.0, tz=timezone.utc),
                            base,
                            "1m",
                            float(candle[1]),
                            float(candle[2]),
                            float(candle[3]),
                            float(candle[4]),
                            float(candle[5]),
                        )
                    )
                logger.info("backfilled %d candles for %s", len(candles), ccxt_symbol)
            except Exception as exc:
                logger.warning("backfill failed for %s: %s", ccxt_symbol, exc)
        if rows:
            await self.market_repo.insert_bars(rows)
            logger.info("committed %d backfilled bars", len(rows))

    # ---------------------------------------------------------------- streams
    async def _ohlcv_stream(self, ccxt_symbol: str) -> None:
        """Consume 1m kline WebSocket updates, buffer and broadcast."""
        base = ccxt_symbol.split("/")[0]
        while not self._shutdown.is_set():
            ohlcvs = await self.exchange.watch_ohlcv(ccxt_symbol, self.settings.MARKET_FEED_RESOLUTION)
            for candle in ohlcvs[-3:]:  # only the freshest updates
                timestamp = datetime.fromtimestamp(candle[0] / 1000.0, tz=timezone.utc)
                bar = BufferedBar(
                    timestamp=timestamp,
                    symbol=base,
                    open=float(candle[1]),
                    high=float(candle[2]),
                    low=float(candle[3]),
                    close=float(candle[4]),
                    volume=float(candle[5]),
                )
                self._bars[f"{base}:{int(timestamp.timestamp())}"] = bar
                await self._publish_tick(bar, ccxt_symbol)

    async def _ticker_stream(self, ccxt_symbol: str) -> None:
        """Consume mark-price / last-price ticker updates."""
        base = ccxt_symbol.split("/")[0]
        while not self._shutdown.is_set():
            ticker = await self.exchange.watch_ticker(ccxt_symbol)
            last = ticker.get("last") or ticker.get("close")
            if last is None:
                continue
            payload = {
                "channel": "price",
                "type": "tick",
                "symbol": base,
                "data": {
                    "symbol": base,
                    "pair": ccxt_symbol,
                    "price": float(last),
                    "bid": ticker.get("bid"),
                    "ask": ticker.get("ask"),
                    "change_pct": (
                        float(ticker["percentage"]) if ticker.get("percentage") is not None else None
                    ),
                    "quote_volume": ticker.get("quoteVolume"),
                },
            }
            await self.bus.publish_json(f"{self.settings.CHANNEL_TICKS}:{base}", payload)

    async def _publish_tick(self, bar: BufferedBar, ccxt_symbol: str) -> None:
        payload = {
            "channel": "price",
            "type": "candle",
            "symbol": bar.symbol,
            "data": {
                "symbol": bar.symbol,
                "pair": ccxt_symbol,
                "time": int(bar.timestamp.timestamp()),
                "open": bar.open,
                "high": bar.high,
                "low": bar.low,
                "close": bar.close,
                "volume": bar.volume,
            },
        }
        await self.bus.publish_json(f"{self.settings.CHANNEL_TICKS}:{bar.symbol}", payload)

    # ------------------------------------------------------------- derivatives
    async def _derivative_loop(self, symbols: List[str]) -> None:
        """Poll funding rate, open interest and long/short ratio."""
        interval = self.settings.DERIVATIVE_POLL_SECONDS
        while not self._shutdown.is_set():
            now = datetime.now(timezone.utc)
            rows: List[tuple] = []
            for ccxt_symbol in symbols:
                base = ccxt_symbol.split("/")[0]
                funding = await self._fetch_funding(ccxt_symbol)
                open_interest = await self._fetch_open_interest(ccxt_symbol)
                long_short = await self._fetch_long_short_ratio(base)
                if funding is None and open_interest is None and long_short is None:
                    continue
                rows.append((now, base, funding, open_interest, long_short))
                payload = {
                    "channel": "derivatives",
                    "type": "snapshot",
                    "symbol": base,
                    "data": {
                        "funding_rate": funding,
                        "open_interest": open_interest,
                        "long_short_ratio": long_short,
                        "as_of": now.isoformat(),
                    },
                }
                await self.bus.publish_json(
                    f"{self.settings.CHANNEL_DERIVATIVES}:{base}", payload
                )
            if rows:
                await self.derivative_repo.insert_snapshots(rows)
                logger.debug("committed %d derivative snapshots", len(rows))
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._shutdown.wait(), timeout=interval)

    async def _fetch_funding(self, ccxt_symbol: str) -> Optional[float]:
        try:
            result = await self.exchange.fetch_funding_rate(ccxt_symbol)
            rate = result.get("fundingRate")
            return float(rate) if rate is not None else None
        except Exception as exc:
            logger.debug("funding fetch failed for %s: %s", ccxt_symbol, exc)
            return None

    async def _fetch_open_interest(self, ccxt_symbol: str) -> Optional[float]:
        base = ccxt_symbol.split("/")[0]
        market_id = SYMBOL_COMPONENT_ALIASES.get(base, f"{base}USDT")
        try:
            response = await self._http.get(
                "https://fapi.binance.com/fapi/v1/openInterest",
                params={"symbol": market_id},
            )
            response.raise_for_status()
            return float(response.json()["openInterest"])
        except Exception as exc:
            logger.debug("open interest fetch failed for %s: %s", market_id, exc)
            return None

    async def _fetch_long_short_ratio(self, base: str) -> Optional[float]:
        market_id = SYMBOL_COMPONENT_ALIASES.get(base, f"{base}USDT")
        try:
            response = await self._http.get(
                "https://fapi.binance.com/futures/data/globalLongShortAccountRatio",
                params={"symbol": market_id, "period": "1h", "limit": 1},
            )
            response.raise_for_status()
            payload = response.json()
            return float(payload[0]["longShortRatio"]) if payload else None
        except Exception as exc:
            logger.debug("long/short fetch failed for %s: %s", market_id, exc)
            return None

    # --------------------------------------------------------------- committer
    async def _commit_loop(self) -> None:
        """Flush buffered candles to TimescaleDB every 5 seconds."""
        while not self._shutdown.is_set():
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._shutdown.wait(), timeout=5.0)
            if not self._bars:
                continue
            rows = [
                (
                    bar.timestamp,
                    bar.symbol,
                    "1m",
                    bar.open,
                    bar.high,
                    bar.low,
                    bar.close,
                    bar.volume,
                )
                for bar in self._bars.values()
            ]
            self._bars.clear()
            try:
                await self.market_repo.insert_bars(rows)
                logger.debug("committed %d bars", len(rows))
            except Exception as exc:
                logger.warning("bar commit failed: %s", exc)


def main() -> None:
    """Process entrypoint: ``python -m workers.market_feed``."""
    service = MarketFeedService()
    asyncio.run(service.start())


if __name__ == "__main__":
    main()
