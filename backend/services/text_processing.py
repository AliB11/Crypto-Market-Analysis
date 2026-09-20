"""Social text preprocessing utilities (pure, dependency-free, fully tested).

This module implements the sanitisation and heuristics stage of the sentiment
ingestion pipeline described in Step 2 of the platform plan:

* strip zero-width / directional Unicode spaces,
* strip URLs, ``$cashtag`` noise, ``#hashtag``-only tokens and ticker spam,
* normalise whitespace and repeated punctuation,
* run lightweight bot detection heuristics,
* compute the dynamic author weight ``W = log(1 + engagement + followers)``.

Everything here is intentionally synchronous and side-effect free so the
module can be unit tested (``backend/tests/test_nlp.py``) without network
access, model weights or async fixtures.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Mapping, Sequence

# --------------------------------------------------------------------- regex bank
# U+200B ZERO WIDTH SPACE, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM,
# U+2060 WORD JOINER, U+00AD SOFT HYPHEN and directional marks U+200E/U+200F.
_INVISIBLE_CHARS = re.compile(r"[\u200b\u200c\u200d\u2060\ufeff\u00ad\u200e\u200f]")

_URL = re.compile(
    r"""(?:https?://|www\.)[^\s<>"']+"""
    r"""|(?:\b[\w.+-]+@[\w-]+\.[\w.]+\b)""",  # also strip bare e-mails
    re.IGNORECASE,
)
_CASHTAG = re.compile(r"(?<![\w$])\$[A-Za-z]{1,10}(?![\w])")
_HASHTAG = re.compile(r"(?<![\w#])#[\w-]+")
_MENTION = re.compile(r"@[A-Za-z0-9_]{1,15}")
_HTML_ENTITY = re.compile(r"&[a-z#0-9]+;", re.IGNORECASE)
_REPEATED_PUNCT = re.compile(r"([!?.])\1{2,}")
_REPEATED_CHARS = re.compile(r"(.)\1{2,}")
_WHITESPACE = re.compile(r"\s+")

# Symbols promoted to plain-text tickers before stripping cashtags.
_TICKER_MAP = {
    "BTC": ("bitcoin", "btc"),
    "ETH": ("ethereum", "eth"),
    "SOL": ("solana", "sol"),
    "BNB": ("bnb",),
    "XRP": ("xrp", "ripple"),
    "DOGE": ("dogecoin", "doge"),
    "ADA": ("cardano", "ada"),
}

# ------------------------------------------------------------------ bot heuristics
_PURE_TIKER_SPAM = re.compile(r"^[\s$#A-Za-z0-9.,!?/]*$")


@dataclass(frozen=True)
class SanitizationResult:
    """Outcome of :func:`sanitize_text`."""

    cleaned_text: str
    was_modified: bool
    contained_url: bool
    contained_cashtag: bool
    contained_mention: bool


@dataclass(frozen=True)
class BotVerdict:
    """Outcome of :func:`detect_bot`.

    ``score`` is a probability-like value in ``[0, 1]``; ``>= threshold``
    (default 0.6) marks the author as a bot/spam account.
    """

    score: float
    is_bot: bool
    reasons: tuple[str, ...] = field(default_factory=tuple)


def sanitize_text(
    text: str,
    symbol: str | None = None,
    *,
    strip_hashtags: bool = True,
    strip_mentions: bool = True,
) -> SanitizationResult:
    """Normalise a raw social post into model-ready text.

    The pipeline is deliberately conservative: it removes *noise* that harms
    transformer inference (URLs, invisible Unicode, ticker spam) while keeping
    the natural language content, emoji polarity and punctuation emphasis.

    Parameters
    ----------
    text:
        Raw post body as delivered by the platform API.
    symbol:
        Optional watchlist symbol (e.g. ``"BTC"``).  When supplied, cashtags
        and known ticker aliases of *other* symbols are removed while the
        canonical asset name is injected once (``"bitcoin"``) so the model
        retains the subject of the post.
    strip_hashtags / strip_mentions:
        Toggle removal of ``#hashtag`` and ``@mention`` tokens.

    Returns
    -------
    SanitizationResult
        The cleaned text plus flags describing what was removed.
    """
    if not text:
        return SanitizationResult("", False, False, False, False)

    original = text
    contained_url = bool(_URL.search(text))
    contained_cashtag = bool(_CASHTAG.search(text))
    contained_mention = bool(_MENTION.search(text))

    cleaned = _INVISIBLE_CHARS.sub("", text)
    cleaned = _URL.sub(" ", cleaned)
    cleaned = _HTML_ENTITY.sub(" ", cleaned)
    cleaned = cleaned.replace("\u00a0", " ")  # NBSP → space

    # Replace the target symbol's cashtag/aliases with the asset name once.
    if symbol is not None:
        symbol = symbol.upper()
        aliases = _TICKER_MAP.get(symbol, (symbol.lower(),))
        cleaned = re.sub(
            rf"(?i)(?<![\w$])\${symbol}(?![\w])",
            lambda _m, _a=aliases[0]: _a,
            cleaned,
        )
        for other, other_aliases in _TICKER_MAP.items():
            if other == symbol:
                continue
            cleaned = re.sub(
                rf"(?i)(?<![\w$])\${other}(?![\w])",
                " ",
                cleaned,
            )
            if not any(a in cleaned.lower() for a in aliases):
                # Only drop other tickers when they're standalone noise.
                for alias in other_aliases:
                    cleaned = re.sub(rf"(?i)(?<![\w]){re.escape(alias)}(?![\w])", " ", cleaned)

    cleaned = _CASHTAG.sub(" ", cleaned)  # strip any residual cashtags
    if strip_hashtags:
        cleaned = _HASHTAG.sub(" ", cleaned)
    if strip_mentions:
        cleaned = _MENTION.sub(" ", cleaned)

    cleaned = cleaned.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    cleaned = _REPEATED_PUNCT.sub(r"\1\1", cleaned)
    cleaned = _REPEATED_CHARS.sub(r"\1\1", cleaned)
    cleaned = _WHITESPACE.sub(" ", cleaned).strip()

    return SanitizationResult(
        cleaned_text=cleaned,
        was_modified=cleaned != original,
        contained_url=contained_url,
        contained_cashtag=contained_cashtag,
        contained_mention=contained_mention,
    )


def detect_bot(
    text: str,
    *,
    author_reach: int = 0,
    engagement: float = 0.0,
    followers_following_ratio: float | None = None,
    account_age_days: float | None = None,
    threshold: float = 0.6,
) -> BotVerdict:
    """Score how likely a post originates from a bot/spam account.

    Heuristics (each contributes additively, bounded to ``[0, 1]``):

    1. **Ticker spam** – posts that are *only* tickers/cashtags carry no
       natural-language signal.
    2. **Engagement anomaly** – very high reach with near-zero engagement
       indicates purchased followers.
    3. **Follower ratio** – ``followers / following >> 1`` together with a
       young account is a classic bot fingerprint (only applied when the
       signals are supplied).
    4. **Character inflation** – long posts of repeated emojis/punctuation.

    Parameters
    ----------
    text:
        *Raw* (pre-sanitisation) post body – noise flags must be visible here.
    """
    reasons: list[str] = []
    score = 0.0

    # 1. ticker-only spam: measure natural-language words AFTER removing
    #    cashtags/hashtags so "$BTC $ETH moon" counts as one word, not four.
    if text and _PURE_TIKER_SPAM.match(text.strip()) and re.search(r"[$#]", text):
        content = _CASHTAG.sub(" ", text)
        content = _HASHTAG.sub(" ", content)
        wordish = re.findall(r"[A-Za-z]{3,}", content)
        if len(wordish) <= 2:
            score += 0.65  # strongest single signal – pure ticker payload
            reasons.append("ticker_only_payload")

    # 2. engagement anomaly (purchased audience)
    if author_reach >= 10_000 and engagement <= author_reach * 1e-4:
        score += 0.3
        reasons.append("engagement_anomaly")

    # 3. follower/following ratio + young account
    if followers_following_ratio is not None and followers_following_ratio > 20.0:
        score += 0.45
        reasons.append("skewed_follower_ratio")
    if account_age_days is not None and account_age_days < 30:
        score += 0.35
        reasons.append("juvenile_account")

    # 4. character inflation
    if len(text) > 0:
        emoji_like = len(re.findall(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]", text))
        if emoji_like >= 10:
            score += 0.2
            reasons.append("emoji_flooding")

    score = min(1.0, score)
    return BotVerdict(score=score, is_bot=score >= threshold, reasons=tuple(reasons))


def author_weight(engagement: float, author_reach: int) -> float:
    """Dynamic author weight ``W = log(1 + engagement + author_reach)``.

    The logarithm compresses the heavy-tailed follower distribution so a
    single whale account cannot dominate the aggregate sentiment of a window.
    Both inputs are clamped at zero (defensive against negative engagement
    counters reported by some platform APIs).

    Returns
    -------
    float
        ``W >= 0``; ``0.0`` when the author has no measurable reach.
    """
    engagement = max(0.0, float(engagement))
    author_reach = max(0, int(author_reach))
    return math.log1p(engagement + author_reach)


def engagement_total(metrics: Mapping[str, float]) -> float:
    """Sum the standard engagement counters of a social post.

    Accepts any subset of ``likes``/``likes_count``/``score``,
    ``retweets``/``reposts``, ``replies``, ``comments``, ``upvotes`` and
    ``quotes``; unknown keys are ignored so platform schemas can evolve.
    """
    keys = (
        "likes",
        "likes_count",
        "score",
        "retweets",
        "reposts",
        "replies",
        "comments",
        "upvotes",
        "quotes",
    )
    total = 0.0
    for key in keys:
        value = metrics.get(key)
        if isinstance(value, (int, float)):
            total += max(0.0, float(value))
    return total


def is_actionable(cleaned_text: str, min_length: int = 3, max_length: int = 512) -> bool:
    """Return ``True`` when a cleaned post is worth sending through inference.

    Filters out empty husks left after URL/cashtag stripping as well as
    pathologically long payloads that only waste batch capacity.
    """
    return min_length <= len(cleaned_text) <= max_length


def batch_texts(records: Sequence[tuple[str, Mapping[str, float]]], batch_size: int) -> list[list[int]]:
    """Group record indices into inference batches of at most ``batch_size``.

    Utility used by the ingestion worker so that batching logic stays
    deterministic and testable independently of the transformer pipeline.
    """
    if batch_size <= 0:
        raise ValueError("batch_size must be positive")
    return [
        list(range(start, min(start + batch_size, len(records))))
        for start in range(0, len(records), batch_size)
    ]
