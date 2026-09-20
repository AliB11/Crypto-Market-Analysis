"""Quantitative engine test suite (Step 6.1 – test_quant.py).

Validates:
* logarithmic returns against hand-computed values and edge cases,
* RSI behaviour on flat / monotonic / short series (no NaN, ever),
* MACD algebra (line = fast EMA - slow EMA, histogram = line - signal),
* confluence normalisation bounds under extreme and degenerate inputs,
* low-liquidity shrink and zero-division protection.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from conftest import make_bars, make_derivatives, make_social
from services.quantitative import (
    EPS,
    QuantitativeEngine,
    SocialObservation,
)

engine = QuantitativeEngine()


# ===========================================================================
# Logarithmic returns
# ===========================================================================
class TestLogReturns:
    def test_matches_manual_computation(self):
        prices = [100.0, 110.0, 99.0]
        returns = engine.log_returns(prices)
        assert returns.shape == (2,)
        assert returns[0] == pytest.approx(math.log(110.0 / 100.0))
        assert returns[1] == pytest.approx(math.log(99.0 / 110.0))

    def test_additivity_over_full_path(self):
        """Sum of log returns = log(P_T / P_0) – the hallmark property."""
        prices = [50_000.0, 51_250.0, 49_800.0, 52_000.0, 47_500.0]
        returns = engine.log_returns(prices)
        assert float(returns.sum()) == pytest.approx(math.log(47_500.0 / 50_000.0))

    def test_empty_and_singleton_series(self):
        assert engine.log_returns([]).size == 0
        assert engine.log_returns([100.0]).size == 0

    def test_non_finite_and_non_positive_prices_are_quarantined(self):
        returns = engine.log_returns([100.0, float("nan"), -5.0, 0.0, 105.0, 110.0])
        # Only the (105 -> 110) pair survives as a computable return.
        assert returns.shape == (1,)
        assert returns[0] == pytest.approx(math.log(110.0 / 105.0))

    def test_none_input_is_safe(self):
        assert engine.log_returns(None).size == 0


# ===========================================================================
# Historical volatility
# ===========================================================================
class TestHistoricalVolatility:
    def test_zero_volatility_for_constant_series(self):
        prices = [100.0 + 0.001 * i for i in range(40)]  # ~deterministic
        vol = engine.historical_volatility(prices, window=30)
        assert vol is not None and vol >= 0.0

    def test_insufficient_data_returns_none(self):
        assert engine.historical_volatility([100.0, 101.0]) is None

    def test_annualisation_scales_with_sqrt_of_periods(self):
        rng = np.random.default_rng(42)
        prices = list(100.0 * np.exp(np.cumsum(rng.normal(0, 0.01, 200))))
        daily = engine.historical_volatility(prices, window=30, periods_per_year=365)
        minute = engine.historical_volatility(
            prices, window=30, periods_per_year=365 * 24 * 60
        )
        assert daily > 0 and minute > 0
        assert minute == pytest.approx(daily * math.sqrt(24 * 60), rel=1e-9)


# ===========================================================================
# RSI
# ===========================================================================
class TestRSI:
    def test_flat_series_returns_neutral_fifty(self):
        closes = [100.0] * 50
        rsi = engine.relative_strength_index(closes, period=14)
        assert rsi == pytest.approx(50.0)

    def test_monotonic_rise_returns_one_hundred(self):
        closes = [100.0 + i for i in range(40)]
        rsi = engine.relative_strength_index(closes, period=14)
        assert rsi == pytest.approx(100.0)

    def test_monotonic_fall_returns_zero(self):
        closes = [100.0 - i for i in range(40)]
        rsi = engine.relative_strength_index(closes, period=14)
        assert rsi == pytest.approx(0.0)

    def test_too_few_bars_returns_none(self):
        assert engine.relative_strength_index([100.0, 101.0], period=14) is None

    def test_rsi_is_finite_and_bounded_on_random_data(self):
        rng = np.random.default_rng(3)
        for _ in range(25):
            closes = list(100.0 * np.exp(np.cumsum(rng.normal(0, 0.02, 120))))
            rsi = engine.relative_strength_index(closes, 14)
            assert rsi is not None
            assert math.isfinite(rsi)
            assert 0.0 <= rsi <= 100.0

    def test_known_rsi_value(self):
        """Hand-computed Wilder RSI for a 15-bar window."""
        closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
                  45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28]
        rsi = engine.relative_strength_index(closes, period=14)
        # First-seed averages: gains mean over 14 deltas, Wilder initial step.
        deltas = np.diff(np.array(closes))
        gains = np.where(deltas > 0, deltas, 0.0)
        losses = np.where(deltas < 0, -deltas, 0.0)
        expected = 100.0 - 100.0 / (1.0 + gains[:14].mean() / max(losses[:14].mean(), EPS))
        assert rsi == pytest.approx(expected, abs=1e-9)
        assert 60.0 <= rsi <= 75.0  # up-trending window -> overbought-ish


# ===========================================================================
# MACD
# ===========================================================================
class TestMACD:
    def test_insufficient_data_returns_none(self):
        assert engine.macd([100.0] * 20, 12, 26, 9) is None

    def test_histogram_equals_line_minus_signal(self):
        closes = list(np.linspace(100, 140, 120) + np.sin(np.linspace(0, 12, 120)) * 2)
        result = engine.macd(closes)
        assert result is not None
        assert result.histogram == pytest.approx(result.macd_line - result.signal_line)

    def test_uptrend_produces_positive_macd_line(self):
        closes = [100.0 * (1.0 + 0.001) ** i for i in range(150)]
        result = engine.macd(closes)
        assert result is not None
        assert result.macd_line > 0

    def test_all_equal_prices_do_not_crash(self):
        result = engine.macd([100.0] * 60)
        assert result is not None
        assert result.macd_line == pytest.approx(0.0)
        assert result.histogram == pytest.approx(0.0)


# ===========================================================================
# Confluence model
# ===========================================================================
class TestConfluence:
    def test_score_bounds_on_random_extreme_inputs(self):
        """Scores must stay within [-100, +100] for adversarial inputs."""
        rng = np.random.default_rng(9)
        for seed in range(150):
            bars = make_bars(
                n=rng.integers(40, 600),
                drift=float(rng.uniform(-0.05, 0.05)),
                volatility=float(rng.uniform(0.0, 0.5)),
                volume=float(rng.choice([0.0, 5.0, 12_000.0, 1e9])),
                seed=seed,
            )
            social = make_social(n=rng.integers(0, 200), polarity_bias=float(rng.uniform(-1, 1)))
            derivatives = make_derivatives(
                funding=float(rng.uniform(-0.01, 0.01)),
                oi_growth=float(rng.uniform(-0.9, 5.0)),
            )
            result = engine.compute_confluence("BTC", bars, social, derivatives)
            assert -100.0 <= result.score <= 100.0
            assert math.isfinite(result.score)
            assert math.isfinite(result.confidence)
            assert 0.0 <= result.confidence <= 1.0

    def test_positive_inputs_yield_positive_score(self):
        bars = make_bars(n=300, drift=0.002, volume=50_000.0, seed=5)
        social = make_social(n=80, polarity_bias=0.7, seed=6)
        derivatives = make_derivatives(funding=-0.0002, oi_growth=0.05)
        result = engine.compute_confluence("BTC", bars, social, derivatives)
        assert result.score > 0
        assert result.regime in {"risk_on", "neutral"}

    def test_extreme_bearish_inputs_stay_bounded(self):
        bars = make_bars(n=300, drift=-0.004, volume=50_000.0, seed=8)
        social = make_social(n=80, polarity_bias=-0.95, seed=9)
        derivatives = make_derivatives(funding=0.005, oi_growth=-0.6)
        result = engine.compute_confluence("BTC", bars, social, derivatives)
        assert -100.0 <= result.score <= -1.0

    def test_empty_inputs_degrade_to_neutral(self):
        result = engine.compute_confluence("BTC", [], [], [])
        assert result.score == pytest.approx(0.0)
        assert result.regime == "neutral"
        assert "insufficient_price_history" in result.warnings
        assert "no_sentiment_samples" in result.warnings
        assert "no_funding_data" in result.warnings

    def test_low_liquidity_shrinks_score_and_warns(self):
        liquid = engine.compute_confluence(
            "BTC", make_bars(volume=250_000.0, seed=21), make_social(), make_derivatives()
        )
        illiquid = engine.compute_confluence(
            "BTC",
            make_bars(volume=100.0, seed=21),
            make_social(),
            make_derivatives(),
        )
        assert "low_liquidity" in illiquid.warnings
        assert abs(illiquid.score) < abs(liquid.score) + EPS
        assert abs(illiquid.score) < 50.0  # shrunk toward zero

    def test_component_normalisation_bounds(self):
        rng = np.random.default_rng(77)
        for _ in range(60):
            bars = make_bars(volatility=float(rng.uniform(0, 0.3)), seed=int(rng.integers(0, 9999)))
            social = make_social(n=50, polarity_bias=float(rng.uniform(-1, 1)))
            derivatives = make_derivatives(funding=float(rng.uniform(-0.02, 0.02)))
            result = engine.compute_confluence("BTC", bars, social, derivatives)
            for component in (result.technical.normalised, result.sentiment.normalised,
                              result.derivative.normalised):
                assert -1.0 <= component <= 1.0

    def test_regime_thresholds(self):
        assert QuantitativeEngine.regime_of(75.0) == "risk_on"
        assert QuantitativeEngine.regime_of(20.0) == "risk_on"
        assert QuantitativeEngine.regime_of(19.9) == "neutral"
        assert QuantitativeEngine.regime_of(-19.9) == "neutral"
        assert QuantitativeEngine.regime_of(-20.0) == "risk_off"
        assert QuantitativeEngine.regime_of(-85.0) == "risk_off"


# ===========================================================================
# Divergence detection
# ===========================================================================
class TestDivergence:
    def _series(self, values, start_hours_ago):
        now = datetime.now(timezone.utc)
        return [
            (now - timedelta(hours=start_hours_ago - i), v)
            for i, v in enumerate(values)
        ]

    def test_bullish_divergence_detected(self):
        """Price: lower low; sentiment: higher low -> bullish."""
        price = self._series(
            [105, 104, 103, 102, 101, 96, 97.5, 99, 100.5, 102,
             101, 94, 96, 98, 100, 101, 102, 103, 104, 105],
            start_hours_ago=20,
        )
        sentiment = self._series(
            [-0.05, -0.15, -0.3, -0.5, -0.65, -0.8, -0.55, -0.35, -0.25, -0.3,
             -0.35, -0.4, -0.3, -0.15, -0.05, 0.05, 0.1, 0.15, 0.2, 0.25],
            start_hours_ago=20,
        )
        detection = QuantitativeEngine.detect_divergence(price, sentiment, pivot_lookback=4)
        assert detection is not None
        assert detection.kind == "bullish"
        assert detection.price_to < detection.price_from
        assert detection.sentiment_to > detection.sentiment_from
        assert 0.0 <= detection.strength <= 1.0

    def test_bearish_divergence_detected(self):
        """Price: higher high; sentiment: lower high -> bearish."""
        price = self._series(
            [95, 96, 97, 98, 99, 104, 102, 100, 99, 98,
             99, 106, 104, 102, 100, 99, 98, 97, 96, 95],
            start_hours_ago=20,
        )
        sentiment = self._series(
            [0.05, 0.1, 0.2, 0.35, 0.5, 0.8, 0.6, 0.5, 0.45, 0.48,
             0.5, 0.55, 0.4, 0.3, 0.2, 0.1, 0.0, -0.1, -0.15, -0.2],
            start_hours_ago=20,
        )
        detection = QuantitativeEngine.detect_divergence(price, sentiment, pivot_lookback=4)
        assert detection is not None
        assert detection.kind == "bearish"
        assert detection.price_to > detection.price_from
        assert detection.sentiment_to < detection.sentiment_from

    def test_aligned_series_produce_no_divergence(self):
        price = self._series([100, 98, 96, 99, 101, 103, 105, 107, 109, 111], start_hours_ago=10)
        sentiment = self._series([-0.6, -0.5, -0.3, -0.1, 0.0, 0.2, 0.4, 0.5, 0.6, 0.7], start_hours_ago=10)
        assert QuantitativeEngine.detect_divergence(price, sentiment, pivot_lookback=3) is None

    def test_short_series_returns_none(self):
        price = self._series([1.0, 2.0, 3.0], start_hours_ago=3)
        sentiment = self._series([0.1, 0.2, 0.3], start_hours_ago=3)
        assert QuantitativeEngine.detect_divergence(price, sentiment) is None


# ===========================================================================
# Sentiment aggregation
# ===========================================================================
class TestSentimentAggregation:
    def test_weighted_polarity_favors_heavy_authors(self):
        now = datetime.now(timezone.utc)
        small = SocialObservation(now, 1.0, 0.9, weight=1.0)      # nobody
        whale = SocialObservation(now, -1.0, 0.9, weight=20.0)    # big account
        weighted = engine.weighted_sentiment([small, whale])
        assert weighted is not None
        assert weighted < 0.0  # whale dominates
        # Effective weights are author weight x confidence.
        expected = (1.0 * 0.9 * 1.0 + 20.0 * 0.9 * -1.0) / (1.0 * 0.9 + 20.0 * 0.9)
        assert weighted == pytest.approx(expected)

    def test_weighted_polarity_empty_returns_none(self):
        assert engine.weighted_sentiment([]) is None

    def test_velocity_positive_when_sentiment_improves(self):
        now = datetime.now(timezone.utc)
        observations = [
            SocialObservation(now - timedelta(hours=10 - i), polarity=-0.8 + 0.18 * i, confidence=0.9)
            for i in range(11)
        ]
        velocity = engine.sentiment_velocity(observations)
        assert velocity is not None
        assert velocity > 0.0

    def test_velocity_none_for_degenerate_time_span(self):
        now = datetime.now(timezone.utc)
        observations = [
            SocialObservation(now, 0.5, 0.9),
            SocialObservation(now, 0.7, 0.9),
        ]
        assert engine.sentiment_velocity(observations) is None
