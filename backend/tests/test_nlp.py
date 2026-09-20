"""NLP pipeline test suite (Step 6.1 – test_nlp.py).

Verifies:
* text sanitation (zero-width Unicode, URLs, cashtags, mentions, spam),
* bot detection heuristics,
* dynamic author weighting ``W = log(1 + engagement + followers)``,
* mock transformer inference: polarity mapping, confidence bounds, batching
  and label-shape robustness – no model weights are downloaded.
"""

from __future__ import annotations

import math

import pytest

from services.nlp import SentimentInferenceEngine, SentimentPrediction
from services.text_processing import (
    author_weight,
    batch_texts,
    detect_bot,
    engagement_total,
    is_actionable,
    sanitize_text,
)


# ===========================================================================
# Text sanitation
# ===========================================================================
class TestSanitizeText:
    def test_strips_zero_width_and_directional_marks(self):
        raw = "Bit\u200bcoin is going \u200dup \ufefftonight\u200e"
        result = sanitize_text(raw)
        assert "\u200b" not in result.cleaned_text
        assert "\u200d" not in result.cleaned_text
        assert "\ufeff" not in result.cleaned_text
        assert "\u200e" not in result.cleaned_text
        assert result.was_modified

    def test_strips_urls(self):
        raw = "BTC pumping because https://t.co/xyz123 see www.coindesk.com/article"
        result = sanitize_text(raw)
        assert "https://" not in result.cleaned_text
        assert "www.coindesk.com" not in result.cleaned_text
        assert result.contained_url
        assert "pumping" in result.cleaned_text

    def test_cashtag_of_target_symbol_becomes_asset_name(self):
        raw = "$BTC to the moon, accumulation zone"
        result = sanitize_text(raw, symbol="BTC")
        assert "$BTC" not in result.cleaned_text
        assert "bitcoin" in result.cleaned_text.lower()
        assert "moon" in result.cleaned_text

    def test_other_cashtags_are_removed(self):
        raw = "I love $SOL but $DOGE is a joke and $ADA is fine"
        result = sanitize_text(raw, symbol="SOL")
        assert "$" not in result.cleaned_text
        assert "solana" in result.cleaned_text.lower()

    def test_hashtags_and_mentions_removed(self):
        raw = "#Bitcoin @elonmusk this is huge!!!"
        result = sanitize_text(raw)
        assert "#" not in result.cleaned_text
        assert "@" not in result.cleaned_text
        assert result.contained_mention is True

    def test_repeated_punctuation_collapsed(self):
        result = sanitize_text("This is HUGE!!!!!!!!!!!!! really????")
        assert "!!" in result.cleaned_text
        assert "!!!!!!!!" not in result.cleaned_text

    def test_whitespace_normalised(self):
        result = sanitize_text("  bitcoin   is   \n\t bullish  ")
        assert result.cleaned_text == "bitcoin is bullish"

    def test_empty_input(self):
        result = sanitize_text("")
        assert result.cleaned_text == ""
        assert not result.was_modified

    def test_preserves_sentiment_bearing_content(self):
        raw = "Honestly $BTC looks weak, expect a flush below 60k before continuation"
        result = sanitize_text(raw, symbol="BTC")
        lowered = result.cleaned_text.lower()
        assert "weak" in lowered
        assert "flush" in lowered
        assert "60k" in lowered


# ===========================================================================
# Bot detection
# ===========================================================================
class TestBotDetection:
    def test_ticker_only_spam_is_flagged(self):
        verdict = detect_bot("$BTC $ETH $SOL 100x!!! moon", author_reach=50)
        assert verdict.is_bot
        assert "ticker_only_payload" in verdict.reasons

    def test_natural_language_is_not_flagged(self):
        verdict = detect_bot(
            "The bitcoin etf inflows doubled this week which is structurally bullish",
            author_reach=25_000,
            engagement=1_500.0,
        )
        assert not verdict.is_bot
        assert verdict.score < 0.6

    def test_engagement_anomaly_flagged(self):
        verdict = detect_bot(
            "Bitcoin will change everything, buy now",
            author_reach=1_000_000,
            engagement=3.0,  # purchased followers
        )
        assert "engagement_anomaly" in verdict.reasons
        assert verdict.score >= 0.3

    def test_juvenile_account_with_skewed_ratio(self):
        verdict = detect_bot(
            "check my signal group",
            followers_following_ratio=55.0,
            account_age_days=5,
        )
        assert verdict.is_bot

    def test_emoji_flooding(self):
        verdict = detect_bot("BTC " + "🚀" * 15)
        assert "emoji_flooding" in verdict.reasons


# ===========================================================================
# Author weighting
# ===========================================================================
class TestAuthorWeight:
    def test_formula_matches_log1p(self):
        assert author_weight(250.0, 10_000) == pytest.approx(math.log1p(250.0 + 10_000))
        assert author_weight(0.0, 0) == 0.0

    def test_monotonic_in_both_inputs(self):
        assert author_weight(10.0, 100) < author_weight(20.0, 100)
        assert author_weight(10.0, 100) < author_weight(10.0, 10_000)

    def test_negative_inputs_clamped(self):
        assert author_weight(-50.0, -5) == 0.0

    def test_whale_cannot_explode_the_weight(self):
        """Log compression: 1M-follower account weighs ~ 2x a 1k account."""
        small = author_weight(10.0, 1_000)
        whale = author_weight(10.0, 1_000_000)
        assert whale < small * 3.0
        assert whale < 15.0


class TestEngagementTotal:
    def test_sums_known_metrics(self):
        total = engagement_total({"likes": 10, "retweets": 5, "replies": 2, "unknown": 99})
        assert total == 17.0

    def test_handles_reddit_style_metrics(self):
        assert engagement_total({"score": 120, "upvotes": 120, "comments": 45}) == 285.0

    def test_ignores_negative_counters(self):
        assert engagement_total({"likes": -5, "retweets": 3}) == 3.0


# ===========================================================================
# Actionability & batching
# ===========================================================================
class TestActionability:
    def test_short_husks_rejected(self):
        assert not is_actionable("")
        assert not is_actionable("ok")
        assert is_actionable("bitcoin looks strong this week")

    def test_overlong_payloads_rejected(self):
        assert not is_actionable("word " * 400)


class TestBatching:
    def test_batches_cover_all_indices_exactly_once(self):
        indices = batch_texts([(f"t{i}", {}) for i in range(75)], batch_size=32)
        flat = [i for batch in indices for i in batch]
        assert flat == list(range(75))
        assert all(len(batch) <= 32 for batch in indices)

    def test_invalid_batch_size_raises(self):
        with pytest.raises(ValueError):
            batch_texts([("a", {})], batch_size=0)


# ===========================================================================
# Mock inference engine
# ===========================================================================
class FakePipeline:
    """Deterministic transformers-pipeline stand-in (no weights)."""

    def __init__(self, label_for_text=None, default_label="positive", score=0.93):
        self.calls: list[list[str]] = []
        self.label_for_text = label_for_text or {}
        self.default_label = default_label
        self.score = score

    def __call__(self, texts):
        self.calls.append(list(texts))
        return [
            {"label": self.label_for_text.get(t, self.default_label), "score": self.score}
            for t in texts
        ]


class TestInferenceEngine:
    def _engine(self, fake: FakePipeline) -> SentimentInferenceEngine:
        return SentimentInferenceEngine(
            pipeline_factory=lambda model_id, device: fake,
            batch_size=8,
            settings=_stub_settings(),
        )

    def test_polarity_mapping_positive_negative_neutral(self):
        fake = FakePipeline(
            label_for_text={
                "great news": "positive",
                "terrible crash": "negative",
                "just an update": "neutral",
            }
        )
        engine = self._engine(fake)
        predictions = engine.score(["great news", "terrible crash", "just an update"])
        assert [p.polarity for p in predictions] == [1.0, -1.0, 0.0]
        assert all(p.confidence == pytest.approx(0.93) for p in predictions)

    def test_batching_respects_batch_size(self):
        fake = FakePipeline(default_label="neutral")
        engine = self._engine(fake)
        texts = [f"text number {i}" for i in range(20)]
        engine.score(texts)
        assert len(fake.calls) == 3  # 8 + 8 + 4
        assert [len(c) for c in fake.calls] == [8, 8, 4]

    def test_result_order_preserved(self):
        fake = FakePipeline(
            label_for_text={f"t{i}": "positive" if i % 2 == 0 else "negative" for i in range(6)}
        )
        engine = self._engine(fake)
        predictions = engine.score([f"t{i}" for i in range(6)])
        assert [p.label for p in predictions] == [
            "positive", "negative", "positive", "negative", "positive", "negative",
        ]

    def test_empty_input_returns_empty(self):
        engine = self._engine(FakePipeline())
        assert engine.score([]) == []

    def test_legacy_output_shapes_supported(self):
        """Pipelines that return tuples or LABEL_0 style keys still parse."""

        class LegacyPipeline:
            def __call__(self, texts):
                return [
                    ([{"label": "LABEL_2", "score": 0.88}],),
                    ({"label": "LABEL_0", "score": 0.77},),
                ]

        engine = SentimentInferenceEngine(
            pipeline_factory=lambda m, d: LegacyPipeline(),
            settings=_stub_settings(),
        )
        predictions = engine.score(["win", "lose"])
        # LABEL_2 -> positive, LABEL_0 -> negative (standard model ordering)
        assert predictions[0].polarity == 1.0
        assert predictions[1].polarity == -1.0

    def test_confidence_clamped_to_unit_interval(self):
        class BrokenPipeline:
            def __call__(self, texts):
                return [{"label": "positive", "score": 1.7} for _ in texts]

        engine = SentimentInferenceEngine(
            pipeline_factory=lambda m, d: BrokenPipeline(),
            settings=_stub_settings(),
        )
        assert engine.score_one("boom").confidence == 1.0

    def test_load_is_idempotent(self):
        fake = FakePipeline()
        engine = self._engine(fake)
        engine.load()
        engine.load()
        assert engine.is_loaded


def _stub_settings():
    """Minimal settings object so the engine never reads a real .env."""
    from config import Settings

    return Settings(
        SENTIMENT_MODEL_ID="fake/test-model",
        NLP_DEVICE="cpu",
        NLP_BATCH_SIZE=8,
        _env_file=None,
    )
