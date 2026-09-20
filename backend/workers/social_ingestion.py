"""Social sentiment ingestion service (Step 2.1).

Asynchronous collectors for **Twitter v2** (official Python SDK –
``tweepy.AsyncClient``) and **Reddit** (official SDK – ``praw``, bridged into
the event loop with ``asyncio.to_thread``) feeding a transformer NLP
pipeline.

Pipeline stages
---------------
1. **Collect** – poll recent posts mentioning the watchlist symbols
   (respecting platform rate limits, retrying HTTP 429 with exponential
   backoff honouring the server-provided ``Retry-After``).
2. **Preprocess** – strip zero-width Unicode, URLs, cashtag noise; run bot
   detection heuristics; drop non-actionable husks.
3. **Weight** – dynamic author weight ``W = log(1 + engagement + reach)``.
4. **Infer** – batch classification through the HuggingFace pipeline
   (``cardiffnlp/twitter-roberta-base-sentiment-latest`` with a
   ``ProsusAI/finbert`` fallback) via
   :class:`services.nlp.SentimentInferenceEngine`.
5. **Persist & broadcast** – upsert into the ``social_sentiment`` hypertable
   and publish every record to the Redis pub/sub channel
   ``sentiment_stream``; high-confidence, high-|polarity| records are
   flagged as alerts which the WebSocket gateway fans out to terminals.

Deduplication is two-layered: a Redis ``SETNX`` bloom-style guard with TTL
prevents duplicate inference cost, and the hypertable primary key
``(timestamp, external_id)`` enforces idempotency at the storage layer.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import random
import signal
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, TypeVar

from cache import RedisBus
from config import Settings, get_settings
from db import Database
from repositories import SentimentRepository
from services.nlp import SentimentInferenceEngine
from services.text_processing import (
    author_weight,
    batch_texts,
    detect_bot,
    engagement_total,
    is_actionable,
    sanitize_text,
)

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-8s %(name)s :: %(message)s",
)
logger = logging.getLogger("worker.social_ingestion")

T = TypeVar("T")

# Symbol -> Reddit communities polled for organic discussion.
SYMBOL_SUBREDDITS: Dict[str, List[str]] = {
    "BTC": ["Bitcoin", "CryptoCurrency"],
    "ETH": ["ethereum", "CryptoCurrency"],
    "SOL": ["solana", "CryptoCurrency"],
    "BNB": ["binance", "CryptoCurrency"],
    "XRP": ["Ripple", "CryptoCurrency"],
    "DOGE": ["dogecoin", "CryptoCurrency"],
    "ADA": ["CardanoAI", "cardano", "CryptoCurrency"],
}

# Common financial-noise terms excluded from match queries.
_NEGATION_TERMS = ("giveaway", "airdrop", "casino", "poker", "betting")


@dataclass
class RawPost:
    """Normalised platform-agnostic post before inference."""

    external_id: str
    platform: str
    symbol: str
    author: str
    author_reach: int
    engagement: float
    engagement_metrics: Dict[str, float]
    created_at: datetime
    raw_text: str


@dataclass
class PreparedPost:
    """Post after sanitisation, bot filtering and weighting."""

    raw: RawPost
    cleaned_text: str
    weight: float


@dataclass
class IngestionStats:
    """Rolling counters exposed in log lines."""

    fetched: int = 0
    bots_filtered: int = 0
    deduped: int = 0
    inferred: int = 0
    stored: int = 0
    published: int = 0

    def log_line(self) -> str:
        return (
            f"fetched={self.fetched} bots_filtered={self.bots_filtered} "
            f"deduped={self.deduped} inferred={self.inferred} "
            f"stored={self.stored} published={self.published}"
        )


async def retry_with_backoff(
    operation: Callable[[], Any],
    *,
    max_attempts: int = 6,
    base_delay: float = 1.0,
    max_delay: float = 120.0,
    retry_on: tuple = (Exception,),
    respect_retry_after: bool = True,
) -> Any:
    """Exponential backoff with jitter, honouring ``Retry-After`` headers.

    Platform APIs (Twitter v2, Reddit) aggressively throttle; the correct
    behaviour is to sleep – recommended delay ``base_delay * 2**attempt``
    plus jitter – rather than hammer the endpoint and extend the penalty
    window.  ``tweepy.TooManyRequests`` and ``praw`` rate-limit errors carry
    a ``response`` attribute whose ``Retry-After`` header is respected when
    present.
    """
    for attempt in range(1, max_attempts + 1):
        try:
            return await operation()
        except asyncio.CancelledError:
            raise
        except retry_on as exc:
            if attempt == max_attempts:
                raise
            delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
            delay *= 0.5 + random.random()  # full jitter
            if respect_retry_after:
                retry_after = _extract_retry_after(exc)
                if retry_after is not None:
                    delay = max(delay, min(float(retry_after), max_delay))
            logger.warning(
                "rate-limited/transient error (attempt %d/%d): %s – sleeping %.1fs",
                attempt,
                max_attempts,
                exc,
                delay,
            )
            await asyncio.sleep(delay)
    raise RuntimeError("unreachable")  # pragma: no cover


def _extract_retry_after(exc: Exception) -> Optional[float]:
    """Pull a Retry-After hint out of SDK-specific rate limit exceptions."""
    response = getattr(exc, "response", None)
    if response is None:
        return None
    headers = getattr(response, "headers", None) or {}
    value = headers.get("Retry-After") or headers.get("x-rate-limit-reset")
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


class TwitterCollector:
    """Twitter v2 recent-search collector (official ``tweepy.AsyncClient``)."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client: Any = None

    def available(self) -> bool:
        return bool(self.settings.TWITTER_BEARER_TOKEN)

    async def _ensure_client(self) -> Any:
        if self._client is None:
            import tweepy  # lazy: official Twitter v2 SDK

            self._client = tweepy.AsyncClient(
                bearer_token=self.settings.TWITTER_BEARER_TOKEN, wait_on_rate_limit=False
            )
        return self._client

    async def collect(self, symbol: str, limit: int) -> List[RawPost]:
        """Fetch recent tweets mentioning the symbol (cashtag or name)."""
        client = await self._ensure_client()
        query = f'$"{symbol}" OR #{symbol} -is:retweet lang:en -{" -".join(_NEGATION_TERMS)}'

        async def _search() -> Any:
            return await client.search_recent_tweets(
                query=query,
                max_results=min(max(10, limit), 100),
                tweet_fields=["created_at", "public_metrics", "author_id", "lang"],
                expansions=["author_id"],
                user_fields=["public_metrics", "username"],
            )

        response = await retry_with_backoff(_search, retry_on=(Exception,))
        if response is None or response.data is None:
            return []

        users = {user.id: user for user in (response.includes or {}).get("users", [])}
        posts: List[RawPost] = []
        for tweet in response.data:
            metrics = dict(tweet.public_metrics or {})
            user = users.get(tweet.author_id)
            followers = int((user.public_metrics or {}).get("followers_count", 0)) if user else 0
            username = user.username if user else str(tweet.author_id)
            posts.append(
                RawPost(
                    external_id=f"twitter:{tweet.id}",
                    platform="twitter",
                    symbol=symbol,
                    author=username,
                    author_reach=followers,
                    engagement=engagement_total(
                        {
                            "likes": metrics.get("like_count", 0),
                            "retweets": metrics.get("retweet_count", 0),
                            "replies": metrics.get("reply_count", 0),
                            "quotes": metrics.get("quote_count", 0),
                        }
                    ),
                    engagement_metrics=metrics,
                    created_at=tweet.created_at or datetime.now(timezone.utc),
                    raw_text=tweet.text or "",
                )
            )
        return posts


class RedditCollector:
    """Reddit collector using the official ``praw`` SDK (thread-bridged)."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._reddit: Any = None

    def available(self) -> bool:
        return bool(self.settings.REDDIT_CLIENT_ID and self.settings.REDDIT_CLIENT_SECRET)

    def _ensure_reddit(self) -> Any:
        if self._reddit is None:
            import praw  # lazy: official Reddit SDK

            self._reddit = praw.Reddit(
                client_id=self.settings.REDDIT_CLIENT_ID,
                client_secret=self.settings.REDDIT_CLIENT_SECRET,
                user_agent=self.settings.REDDIT_USER_AGENT,
                check_for_updates=False,
            )
        return self._reddit

    async def collect(self, symbol: str, limit: int) -> List[RawPost]:
        """Fetch the newest posts from the symbol's subreddits."""
        subreddits = SYMBOL_SUBREDDITS.get(symbol.upper(), ["CryptoCurrency"])

        def _fetch() -> List[RawPost]:
            reddit = self._ensure_reddit()
            posts: List[RawPost] = []
            for name in subreddits:
                try:
                    for submission in reddit.subreddit(name).new(limit=max(10, limit // len(subreddits))):
                        if symbol.lower() not in (submission.title + " " + submission.selftext).lower():
                            continue
                        metrics = {
                            "score": submission.score or 0,
                            "upvotes": submission.ups or 0,
                            "comments": submission.num_comments or 0,
                        }
                        posts.append(
                            RawPost(
                                external_id=f"reddit:{submission.id}",
                                platform="reddit",
                                symbol=symbol.upper(),
                                author=str(submission.author) if submission.author else "[deleted]",
                                author_reach=getattr(
                                    submission.author, "link_karma", 0
                                ) if submission.author else 0,
                                engagement=engagement_total(metrics),
                                engagement_metrics=metrics,
                                created_at=datetime.fromtimestamp(
                                    submission.created_utc, tz=timezone.utc
                                ),
                                raw_text=f"{submission.title}. {submission.selftext or ''}".strip(),
                            )
                        )
                except Exception as exc:
                    logger.warning("reddit fetch failed for r/%s: %s", name, exc)
            return posts

        return await retry_with_backoff(
            lambda: asyncio.to_thread(_fetch), retry_on=(Exception,)
        )


class SocialIngestionService:
    """Orchestrates collect -> preprocess -> weight -> infer -> store."""

    def __init__(self, settings: Optional[Settings] = None) -> None:
        self.settings = settings or get_settings()
        self.db = Database(self.settings)
        self.bus = RedisBus(self.settings)
        self.sentiment_repo: Optional[SentimentRepository] = None
        self.engine = SentimentInferenceEngine(settings=self.settings)
        self.twitter = TwitterCollector(self.settings)
        self.reddit = RedditCollector(self.settings)
        self._shutdown = asyncio.Event()
        self.stats = IngestionStats()

    # ------------------------------------------------------------- lifecycle
    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            with contextlib.suppress(NotImplementedError):
                loop.add_signal_handler(sig, self._shutdown.set)

        await self.db.connect()
        await self.bus.connect()
        self.sentiment_repo = SentimentRepository(self.db)

        collectors: List[Any] = []
        if self.twitter.available():
            collectors.append(self.twitter)
        else:
            logger.warning("TWITTER_BEARER_TOKEN not set – twitter collection disabled")
        if self.reddit.available():
            collectors.append(self.reddit)
        else:
            logger.warning("REDDIT credentials not set – reddit collection disabled")
        if not collectors:
            logger.error("no social platform credentials configured – nothing to ingest")

        # Load model weights once, before entering the supervised loop.
        await asyncio.to_thread(self.engine.load)

        while not self._shutdown.is_set():
            cycle_started = asyncio.get_running_loop().time()
            try:
                for collector in collectors:
                    await self._ingest_round(collector)
                logger.info("ingestion cycle complete: %s", self.stats.log_line())
            except Exception as exc:
                logger.exception("ingestion cycle failed: %s", exc)
            elapsed = asyncio.get_running_loop().time() - cycle_started
            wait = max(5.0, self.settings.SOCIAL_POLL_SECONDS - elapsed)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._shutdown.wait(), timeout=wait)

        logger.info("social ingestion stopped")
        await self.bus.close()
        await self.db.close()

    # ------------------------------------------------------------ ingestion
    async def _ingest_round(self, collector: Any) -> None:
        """One collect->infer->store pass for every watchlist symbol."""
        for symbol in self.settings.SYMBOLS:
            if self._shutdown.is_set():
                return
            posts = await collector.collect(symbol, self.settings.SOCIAL_LOOKBACK_POSTS)
            self.stats.fetched += len(posts)
            prepared = self._prepare(posts)
            await self._infer_and_store(prepared)

    def _prepare(self, posts: Sequence[RawPost]) -> List[PreparedPost]:
        """Sanitise, bot-filter, dedupe and weight raw posts."""
        prepared: List[PreparedPost] = []
        for post in posts:
            verdict = detect_bot(
                post.raw_text,
                author_reach=post.author_reach,
                engagement=post.engagement,
            )
            if verdict.is_bot:
                self.stats.bots_filtered += 1
                continue
            sanitized = sanitize_text(post.raw_text, symbol=post.symbol)
            if not is_actionable(sanitized.cleaned_text):
                continue
            prepared.append(
                PreparedPost(
                    raw=post,
                    cleaned_text=sanitized.cleaned_text,
                    weight=author_weight(post.engagement, post.author_reach),
                )
            )
        return prepared

    async def _infer_and_store(self, prepared: Sequence[PreparedPost]) -> None:
        """Batch inference -> TimescaleDB upsert -> Redis broadcast."""
        if not prepared:
            return

        # Layer-1 dedup: skip inference for posts seen recently (Redis TTL).
        unseen: List[PreparedPost] = []
        for item in prepared:
            if await self.bus.client.set(f"seen:{item.raw.external_id}", 1, ex=86400, nx=True):
                unseen.append(item)
            else:
                self.stats.deduped += 1
        if not unseen:
            return

        predictions = await asyncio.to_thread(
            self.engine.score, [item.cleaned_text for item in unseen]
        )
        self.stats.inferred += len(predictions)

        rows: List[tuple] = []
        for item, prediction in zip(unseen, predictions):
            rows.append(
                (
                    item.raw.created_at,
                    item.raw.platform,
                    item.raw.symbol.upper(),
                    item.raw.external_id,
                    item.raw.author,
                    item.raw.author_reach,
                    json.dumps(item.raw.engagement_metrics),
                    item.cleaned_text,
                    prediction.polarity,
                    prediction.confidence,
                    item.weight,
                )
            )
            await self._broadcast(item, prediction)

        stored = await self.sentiment_repo.insert_records(rows)
        self.stats.stored += stored

    async def _broadcast(self, item: PreparedPost, prediction) -> None:
        """Publish the record to ``sentiment_stream`` (alerts flagged)."""
        is_alert = (
            prediction.confidence >= self.settings.SOCIAL_ALERT_MIN_CONFIDENCE
            and abs(prediction.polarity) >= self.settings.SOCIAL_ALERT_MIN_ABS_POLARITY
        )
        payload = {
            "channel": "sentiment",
            "type": "alert" if is_alert else "update",
            "symbol": item.raw.symbol.upper(),
            "data": {
                "platform": item.raw.platform,
                "symbol": item.raw.symbol.upper(),
                "author": item.raw.author,
                "author_reach": item.raw.author_reach,
                "engagement": item.raw.engagement,
                "text": item.cleaned_text[:280],
                "polarity": prediction.polarity,
                "confidence": prediction.confidence,
                "label": prediction.label,
                "weight": item.weight,
                "timestamp": item.raw.created_at.isoformat(),
            },
        }
        await self.bus.publish_json(self.settings.CHANNEL_SENTIMENT, payload)
        self.stats.published += 1


def main() -> None:
    """Process entrypoint: ``python -m workers.social_ingestion``."""
    service = SocialIngestionService()
    asyncio.run(service.start())


if __name__ == "__main__":
    main()
