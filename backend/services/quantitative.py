"""Quantitative analysis and multi-factor confluence engine (Step 3).

This module implements the platform's quantitative core as a pure, NumPy-based
object-oriented suite:

* :meth:`QuantitativeEngine.log_returns` – logarithmic returns
  ``r_t = ln(P_t / P_{t-1})``.
* :meth:`QuantitativeEngine.historical_volatility` – annualised rolling
  standard deviation of log returns, ``sigma_ann = sigma_period * sqrt(N)``.
* :meth:`QuantitativeEngine.relative_strength_index` – Wilder-smoothed RSI.
* :meth:`QuantitativeEngine.macd` – MACD(12, 26, 9) with signal and histogram.
* :meth:`QuantitativeEngine.compute_confluence` – bounded multi-factor score
  ``S in [-100, +100]`` blending:

  ======================  ======  =============================================
  Component               Weight  Signal
  ======================  ======  =============================================
  Technical momentum       35 %   RSI displacement from 50 + MACD state
  Sentiment velocity       35 %   Reach-weighted polarity, its slope, and
                                  automated bullish/bearish divergence
  Derivative dynamics      30 %   Funding-rate deviation from baseline zero
                                  and open-interest delta
  ======================  ======  =============================================

Design rules
------------
* **Pure functions over raw NumPy arrays** – no I/O, no globals; trivially
  unit-testable and reusable by both the Celery worker and the API layer.
* **NaN / inf quarantine** – every accessor defensively drops non-finite
  values before aggregation; single-NaN inputs never poison a whole window.
* **Zero-division protection** – denominators are guarded with ``EPS`` or
  explicit branch checks (flat prices -> neutral RSI of 50, zero ATR -> zero
  MACD normalisation, empty windows -> ``None`` rather than ``NaN``).
* **Low-liquidity degradation** – when median quote volume is below the
  configured threshold the composite score is shrunk toward zero and a
  ``low_liquidity`` warning is emitted instead of amplifying noise.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Sequence, Tuple

import numpy as np

EPS: float = 1e-12
MIN_BARS_FOR_INDICATORS: int = 35  # slow MACD(26) + signal warm-up

# Component weights of the confluence model (must sum to 1.0).
WEIGHT_TECHNICAL: float = 0.35
WEIGHT_SENTIMENT: float = 0.35
WEIGHT_DERIVATIVE: float = 0.30

# Saturation constants for sub-signal normalisation.
RSI_NEUTRAL: float = 50.0
MACD_HISTOGRAM_SCALE_PCT: float = 0.002  # 20 bps of price saturates the MACD factor
FUNDING_SCALE: float = 0.0005  # 0.05 % per 8h saturates the funding factor
OI_DELTA_SCALE_PCT: float = 10.0  # +/-10 % 24h OI change saturates the OI factor
VOLATILITY_ANNUALISATION: float = 365.0  # crypto trades every day
VELOCITY_SATURATION_PER_HOUR: float = 0.4  # polarity/hour that saturates velocity
CONFIDENCE_REGIME_THRESHOLD: float = 20.0  # |S| >= 20 leaves the neutral regime


# ===========================================================================
# Value objects
# ===========================================================================
@dataclass(frozen=True)
class OHLCVBar:
    """A single candlestick bar (bucket-open stamped)."""

    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


@dataclass(frozen=True)
class SocialObservation:
    """One classified social post relevant to a symbol."""

    timestamp: datetime
    polarity: float  # [-1, 1]
    confidence: float  # [0, 1]
    weight: float = 1.0  # W = log(1 + engagement + reach), >= 0
    platform: str = "twitter"


@dataclass(frozen=True)
class DerivativeObservation:
    """Derivative market snapshot for a symbol at a point in time."""

    timestamp: datetime
    funding_rate: Optional[float] = None  # fraction per 8h, e.g. 0.0001
    open_interest: Optional[float] = None  # quote-asset units
    long_short_ratio: Optional[float] = None


@dataclass(frozen=True)
class MACDResult:
    """MACD line, signal line and histogram (latest values)."""

    macd_line: float
    signal_line: float
    histogram: float


@dataclass(frozen=True)
class DivergenceDetection:
    """Automated price <-> sentiment divergence detection result."""

    kind: str  # "bullish" | "bearish"
    detected_at: datetime
    price_pivot_time: datetime
    price_from: float
    price_to: float
    sentiment_from: float
    sentiment_to: float
    strength: float  # [0, 1]

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "detected_at": self.detected_at.isoformat(),
            "price_pivot_time": self.price_pivot_time.isoformat(),
            "price_from": self.price_from,
            "price_to": self.price_to,
            "sentiment_from": self.sentiment_from,
            "sentiment_to": self.sentiment_to,
            "strength": self.strength,
        }


@dataclass(frozen=True)
class TechnicalComponent:
    rsi: Optional[float]
    macd: Optional[MACDResult]
    historical_volatility: Optional[float]
    last_close: Optional[float]
    normalised: float  # bounded [-1, 1]


@dataclass(frozen=True)
class SentimentComponent:
    weighted_polarity: Optional[float]
    velocity: Optional[float]
    divergence: Optional[DivergenceDetection]
    sample_size: int
    normalised: float  # bounded [-1, 1]


@dataclass(frozen=True)
class DerivativeComponent:
    funding_rate: Optional[float]
    funding_deviation: Optional[float]
    open_interest: Optional[float]
    open_interest_delta_pct: Optional[float]
    long_short_ratio: Optional[float]
    normalised: float  # bounded [-1, 1]


@dataclass(frozen=True)
class ConfluenceResult:
    """Full result of the confluence computation, including sub-components."""

    symbol: str
    score: float  # [-100, +100]
    regime: str  # "risk_on" | "neutral" | "risk_off"
    confidence: float  # [0, 1]
    technical: TechnicalComponent
    sentiment: SentimentComponent
    derivative: DerivativeComponent
    warnings: Tuple[str, ...] = field(default_factory=tuple)
    computed_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


# ===========================================================================
# Engine
# ===========================================================================
class QuantitativeEngine:
    """Stateless suite of quantitative primitives plus the confluence model.

    All heavy lifting operates on plain ``Sequence[float]`` / NumPy arrays so
    the class is cheap to instantiate per request.
    """

    # ------------------------------------------------------------ primitives
    @staticmethod
    def log_returns(prices: Sequence[float]) -> np.ndarray:
        """Logarithmic returns ``r_t = ln(P_t / P_{t-1})``.

        Parameters
        ----------
        prices:
            Ordered price series (oldest -> newest).  Non-finite entries and
            non-positive prices are dropped together with the return spanning
            them, keeping the series temporally consistent.

        Returns
        -------
        np.ndarray
            ``len(valid_prices) - 1`` log returns; empty array for fewer than
            two valid prices.
        """
        if prices is None:
            return np.empty(0)
        # Pairwise semantics: a return is kept only when BOTH endpoints are
        # valid, so a NaN/corrupted price never produces a spurious jump.
        returns: List[float] = []
        for previous, current in zip(prices, prices[1:]):
            try:
                p_prev = float(previous)
                p_curr = float(current)
            except (TypeError, ValueError):
                continue
            if not (math.isfinite(p_prev) and math.isfinite(p_curr)):
                continue
            if p_prev <= 0.0 or p_curr <= 0.0:
                continue
            returns.append(math.log(p_curr / p_prev))
        return np.array(returns, dtype=float)

    @staticmethod
    def historical_volatility(
        prices: Sequence[float],
        window: int = 30,
        periods_per_year: float = VOLATILITY_ANNUALISATION,
    ) -> Optional[float]:
        """Annualised historical (close-to-close) volatility.

        ``sigma_ann = std(r_t, ddof=1) * sqrt(periods_per_year)``

        With daily sampling and ``periods_per_year=365`` this is the standard
        crypto 30-day volatility (crypto never closes).  With 1-minute bars
        pass ``periods_per_year = 365 * 24 * 60``.

        Returns
        -------
        float or None
            ``None`` when fewer than three returns are available (insufficient
            sample), otherwise the annualised sigma.
        """
        returns = QuantitativeEngine.log_returns(prices)
        if returns.size < 3:
            return None
        effective_window = min(window, returns.size) if window > 0 else returns.size
        sample = returns[-effective_window:]
        sigma = float(np.std(sample, ddof=1))
        return float(sigma * math.sqrt(periods_per_year))

    @staticmethod
    def relative_strength_index(closes: Sequence[float], period: int = 14) -> Optional[float]:
        """Wilder's RSI over the latest ``period`` changes.

        ``RSI = 100 - 100 / (1 + RS)`` where ``RS = avg_gain / avg_loss`` and
        averages use Wilder's exponential smoothing (alpha = 1/period).

        Edge cases
        ----------
        * **Flat series** (avg_gain = avg_loss = 0): returns the neutral
          ``50.0`` instead of NaN.
        * **Monotonic rise** (avg_loss = 0): returns ``100.0``.
        * **Monotonic fall** (avg_gain = 0): returns ``0.0``.
        * **Too few bars** (fewer than ``period + 1``): returns ``None``.

        Returns
        -------
        float or None
            RSI in ``[0, 100]``.
        """
        cleaned = np.array([c for c in closes if np.isfinite(c)], dtype=float)
        if cleaned.size < period + 1 or period <= 0:
            return None
        deltas = np.diff(cleaned)
        gains = np.where(deltas > 0, deltas, 0.0)
        losses = np.where(deltas < 0, -deltas, 0.0)

        avg_gain = float(np.mean(gains[:period]))
        avg_loss = float(np.mean(losses[:period]))

        # Wilder smoothing over the remainder of the series.
        for gain, loss in zip(gains[period:], losses[period:]):
            avg_gain = (avg_gain * (period - 1) + float(gain)) / period
            avg_loss = (avg_loss * (period - 1) + float(loss)) / period

        if avg_loss <= EPS:
            return 100.0 if avg_gain > EPS else RSI_NEUTRAL
        rs = avg_gain / avg_loss
        return float(100.0 - 100.0 / (1.0 + rs))

    @staticmethod
    def macd(
        closes: Sequence[float],
        fast: int = 12,
        slow: int = 26,
        signal: int = 9,
    ) -> Optional[MACDResult]:
        """Standard MACD with EMA semantics and a histogram series.

        ``MACD_line = EMA_fast - EMA_slow``
        ``Signal_line = EMA_signal(MACD_line)``
        ``Histogram = MACD_line - Signal_line``

        EMAs are seeded with the SMA of the first ``span`` values (the
        classic charting convention), avoiding the first-value bias of a
        naive recursive seed.

        Returns
        -------
        MACDResult or None
            ``None`` when fewer than ``slow + signal`` finite closes exist.
        """
        cleaned = np.array([c for c in closes if np.isfinite(c)], dtype=float)
        if cleaned.size < slow + signal:
            return None

        def ema_series(values: np.ndarray, span: int) -> np.ndarray:
            alpha = 2.0 / (span + 1.0)
            seed = float(np.mean(values[:span]))
            out = np.empty(values.size)
            out[: span - 1] = np.nan
            out[span - 1] = seed
            for index in range(span, values.size):
                out[index] = alpha * values[index] + (1.0 - alpha) * out[index - 1]
            return out

        ema_fast = ema_series(cleaned, fast)
        ema_slow = ema_series(cleaned, slow)
        macd_line = ema_fast[slow - 1 :] - ema_slow[slow - 1 :]
        if macd_line.size < signal:
            return None
        signal_line = ema_series(macd_line, signal)
        if not np.isfinite(signal_line[-1]):
            return None
        latest_macd = float(macd_line[-1])
        latest_signal = float(signal_line[-1])
        return MACDResult(
            macd_line=latest_macd,
            signal_line=latest_signal,
            histogram=latest_macd - latest_signal,
        )

    # ------------------------------------------------------- technical factor
    def compute_technical(
        self,
        bars: Sequence[OHLCVBar],
        *,
        rsi_period: int = 14,
        macd_fast: int = 12,
        macd_slow: int = 26,
        macd_signal: int = 9,
        volatility_window: int = 30,
        periods_per_year: float = VOLATILITY_ANNUALISATION,
    ) -> TechnicalComponent:
        """Normalised technical momentum component in ``[-1, 1]``.

        ``T = 0.5 * clip((RSI - 50) / 25, -1, 1)
             + 0.5 * tanh(Histogram% / MACD_HISTOGRAM_SCALE_PCT)``

        where ``Histogram% = Histogram / last_close`` makes the oscillator
        scale-invariant across a $0.10 meme coin and a $60k BTC.
        """
        closes = [bar.close for bar in bars]
        last_close = closes[-1] if closes else None
        rsi = self.relative_strength_index(closes, rsi_period)
        macd = self.macd(closes, macd_fast, macd_slow, macd_signal)
        vol = self.historical_volatility(closes, volatility_window, periods_per_year)

        if rsi is None or macd is None or last_close is None or last_close <= 0:
            return TechnicalComponent(
                rsi=rsi, macd=macd, historical_volatility=vol,
                last_close=last_close, normalised=0.0,
            )

        rsi_factor = float(np.clip((rsi - RSI_NEUTRAL) / 25.0, -1.0, 1.0))
        histogram_pct = macd.histogram / max(last_close, EPS)
        macd_factor = float(np.tanh(histogram_pct / MACD_HISTOGRAM_SCALE_PCT))
        normalised = float(np.clip(0.5 * rsi_factor + 0.5 * macd_factor, -1.0, 1.0))
        return TechnicalComponent(
            rsi=rsi, macd=macd, historical_volatility=vol,
            last_close=last_close, normalised=normalised,
        )

    # ------------------------------------------------------- sentiment factor
    def weighted_sentiment(self, observations: Sequence[SocialObservation]) -> Optional[float]:
        """Weighted mean polarity ``E_w[p] = Sum(w_i * p_i) / Sum(w_i)``.

        Effective weights are the author weights
        ``w_i = log(1 + engagement + reach)`` multiplied by model confidence,
        so an unconfident classification of a whale post cannot outweigh
        confident classifications of smaller accounts.
        """
        weighted_sum = 0.0
        total_weight = 0.0
        for observation in observations:
            if not (np.isfinite(observation.polarity) and np.isfinite(observation.weight)):
                continue
            weight = max(0.0, observation.weight) * max(0.0, observation.confidence)
            weighted_sum += weight * float(np.clip(observation.polarity, -1.0, 1.0))
            total_weight += weight
        if total_weight <= EPS:
            return None
        return float(np.clip(weighted_sum / total_weight, -1.0, 1.0))

    @staticmethod
    def sentiment_velocity(observations: Sequence[SocialObservation]) -> Optional[float]:
        """Least-squares slope of weighted polarity over time, per hour.

        Buckets observations into six equal time slices over the observation
        span, computes the weighted mean polarity per slice, and fits
        ``p(t) = a + b*t``.  Returns ``b`` clipped to ``[-1, 1]`` where a
        slope of ``VELOCITY_SATURATION_PER_HOUR`` polarity units per hour
        saturates the factor.  ``None`` when fewer than two populated buckets
        exist or the time span is degenerate.
        """
        valid = [o for o in observations if np.isfinite(o.polarity)]
        if len(valid) < 2:
            return None
        times = [o.timestamp for o in valid]
        t_min, t_max = min(times), max(times)
        span_seconds = (t_max - t_min).total_seconds()
        if span_seconds <= 0:
            return None

        n_buckets = 6
        bucket_sums = {i: 0.0 for i in range(n_buckets)}
        bucket_weights = {i: 0.0 for i in range(n_buckets)}
        for observation in valid:
            offset = (observation.timestamp - t_min).total_seconds() / span_seconds
            index = min(n_buckets - 1, int(offset * n_buckets))
            weight = max(EPS, observation.weight) * max(EPS, observation.confidence)
            bucket_sums[index] += weight * observation.polarity
            bucket_weights[index] += weight

        populated = [
            (index, bucket_sums[index] / bucket_weights[index])
            for index in range(n_buckets)
            if bucket_weights[index] > EPS
        ]
        if len(populated) < 2:
            return None

        span_hours = max(span_seconds / 3600.0, EPS)
        x = np.array([i for i, _ in populated], dtype=float) / n_buckets * span_hours
        y = np.array([p for _, p in populated], dtype=float)
        slope = float(np.polyfit(x, y, 1)[0])
        if not np.isfinite(slope):
            return None
        return float(np.clip(slope / VELOCITY_SATURATION_PER_HOUR, -1.0, 1.0))

    @staticmethod
    def detect_divergence(
        price_series: Sequence[Tuple[datetime, float]],
        sentiment_series: Sequence[Tuple[datetime, float]],
        *,
        pivot_lookback: int = 6,
        now: Optional[datetime] = None,
    ) -> Optional[DivergenceDetection]:
        """Detect bullish/bearish divergence between price and sentiment.

        **Bullish divergence** - price prints a *lower low* while social
        sentiment prints a *higher low* (crowd capitulation is decaying
        faster than price): a mean-reversion long bias.

        **Bearish divergence** - price prints a *higher high* while sentiment
        prints a *lower high*: a distribution footprint.

        Local pivots are identified with a symmetric ``pivot_lookback``
        window on both series; the most recent pair of same-type pivots is
        compared.  ``strength`` combines the relative price extension and the
        sentiment shift, bounded to ``[0, 1]``.

        Returns
        -------
        DivergenceDetection or None
            ``None`` when either series lacks sufficient pivot structure.
        """
        if len(price_series) < 2 * pivot_lookback or len(sentiment_series) < 2 * pivot_lookback:
            return None
        now = now or datetime.now(timezone.utc)

        def local_pivots(
            series: Sequence[Tuple[datetime, float]], mode: str
        ) -> List[Tuple[datetime, float]]:
            pivots: List[Tuple[datetime, float]] = []
            values = np.array([v for _, v in series], dtype=float)
            for index in range(pivot_lookback, len(series) - pivot_lookback):
                window = values[index - pivot_lookback : index + pivot_lookback + 1]
                center = values[index]
                if not np.isfinite(center):
                    continue
                if mode == "low" and center <= window.min() + EPS:
                    pivots.append(series[index])
                elif mode == "high" and center >= window.max() - EPS:
                    pivots.append(series[index])
            return pivots

        def evaluate(
            price_pivots: List[Tuple[datetime, float]],
            sentiment_pivots: List[Tuple[datetime, float]],
            mode: str,
        ) -> Optional[DivergenceDetection]:
            if len(price_pivots) < 2 or len(sentiment_pivots) < 2:
                return None
            p_prev, p_last = price_pivots[-2], price_pivots[-1]
            s_prev, s_last = sentiment_pivots[-2], sentiment_pivots[-1]
            price_move = p_last[1] - p_prev[1]
            sentiment_move = s_last[1] - s_prev[1]

            if mode == "bullish":
                qualifies = price_move < 0 and sentiment_move > 0
            else:
                qualifies = price_move > 0 and sentiment_move < 0
            if not qualifies:
                return None

            price_scale = max(abs(p_prev[1]), EPS)
            price_extent = abs(price_move) / price_scale
            sentiment_extent = min(1.0, abs(sentiment_move) / 0.5)
            strength = float(np.clip(0.5 * price_extent + 0.5 * sentiment_extent, 0.0, 1.0))
            return DivergenceDetection(
                kind=mode,
                detected_at=now,
                price_pivot_time=p_last[0],
                price_from=p_prev[1],
                price_to=p_last[1],
                sentiment_from=s_prev[1],
                sentiment_to=s_last[1],
                strength=strength,
            )

        bullish = evaluate(
            local_pivots(price_series, "low"), local_pivots(sentiment_series, "low"), "bullish"
        )
        if bullish is not None:
            return bullish
        return evaluate(
            local_pivots(price_series, "high"), local_pivots(sentiment_series, "high"), "bearish"
        )

    def compute_sentiment(
        self,
        observations: Sequence[SocialObservation],
        price_series: Sequence[Tuple[datetime, float]],
        *,
        now: Optional[datetime] = None,
    ) -> SentimentComponent:
        """Normalised sentiment velocity component in ``[-1, 1]``.

        ``E = clip(0.55 * weighted_polarity
                 + 0.45 * (0.6 * velocity + 0.4 * divergence_bias), -1, 1)``

        where ``divergence_bias`` is ``+strength`` for a bullish divergence,
        ``-strength`` for bearish and ``0`` otherwise.  With no social data
        the component degrades to ``0`` (neutral) rather than ``NaN``.
        """
        if not observations:
            return SentimentComponent(None, None, None, 0, 0.0)

        weighted_polarity = self.weighted_sentiment(observations)
        velocity = self.sentiment_velocity(observations)

        # Aggregate sentiment per hour for divergence comparison.
        buckets: dict[str, Tuple[datetime, float, float]] = {}
        for observation in observations:
            key = observation.timestamp.replace(minute=0, second=0, microsecond=0).isoformat()
            weight = max(EPS, observation.weight * observation.confidence)
            acc = buckets.get(key)
            if acc is None:
                buckets[key] = (observation.timestamp, observation.polarity * weight, weight)
            else:
                ts, acc_sum, acc_weight = acc
                buckets[key] = (ts, acc_sum + observation.polarity * weight, acc_weight + weight)
        sentiment_hourly: List[Tuple[datetime, float]] = [
            (ts, acc_sum / acc_weight) for ts, acc_sum, acc_weight in buckets.values()
        ]
        sentiment_hourly.sort(key=lambda item: item[0])

        divergence = None
        if len(sentiment_hourly) >= 8 and len(price_series) >= 8:
            divergence = self.detect_divergence(price_series, sentiment_hourly, now=now)

        if weighted_polarity is None:
            return SentimentComponent(None, velocity, divergence, len(observations), 0.0)

        divergence_bias = 0.0
        if divergence is not None:
            divergence_bias = (
                divergence.strength if divergence.kind == "bullish" else -divergence.strength
            )
        velocity_term = velocity if velocity is not None else 0.0
        normalised = 0.55 * weighted_polarity + 0.45 * (
            0.6 * velocity_term + 0.4 * divergence_bias
        )
        return SentimentComponent(
            weighted_polarity=weighted_polarity,
            velocity=velocity,
            divergence=divergence,
            sample_size=len(observations),
            normalised=float(np.clip(normalised, -1.0, 1.0)),
        )

    # ------------------------------------------------------ derivative factor
    def compute_derivative(
        self,
        observations: Sequence[DerivativeObservation],
        *,
        price_momentum: float = 0.0,
        funding_baseline: float = 0.0,
        funding_scale: float = FUNDING_SCALE,
        oi_delta_scale_pct: float = OI_DELTA_SCALE_PCT,
    ) -> DerivativeComponent:
        """Normalised derivative dynamics component in ``[-1, 1]``.

        ``funding_deviation = (funding - baseline) / funding_scale`` clipped
        to ``[-1, 1]``; contrarian interpretation - crowded longs paying rich
        positive funding are a *risk* signal, deeply negative funding signals
        short-squeeze fuel:

        ``D = clip(0.6 * (-tanh(funding_deviation))
                 + 0.4 * sign(price_momentum) * tanh(|dOI%| / scale), -1, 1)``

        Open-interest delta confirms trends: OI expanding in the direction of
        recent price momentum adds signal; OI expanding against momentum is
        fade-risk and subtracts.
        """
        ordered = sorted(
            [
                o
                for o in observations
                if o.funding_rate is not None or o.open_interest is not None
            ],
            key=lambda o: o.timestamp,
        )
        if not ordered:
            return DerivativeComponent(None, None, None, None, None, 0.0)

        latest = ordered[-1]
        funding_rate = latest.funding_rate
        funding_deviation: Optional[float] = None
        if funding_rate is not None and np.isfinite(funding_rate):
            funding_deviation = float(
                np.clip((funding_rate - funding_baseline) / max(funding_scale, EPS), -1.0, 1.0)
            )

        # 24h open-interest delta (or the widest available window).
        oi_now = latest.open_interest
        oi_delta_pct: Optional[float] = None
        if oi_now is not None and np.isfinite(oi_now) and oi_now > 0:
            cutoff = latest.timestamp - timedelta(hours=24)
            history = [o for o in ordered if o.open_interest and o.timestamp <= cutoff]
            if not history:
                history = [
                    o for o in ordered if o.open_interest and o.timestamp < latest.timestamp
                ]
            if history:
                oi_ref = history[0].open_interest
                if oi_ref is not None and np.isfinite(oi_ref) and oi_ref > 0:
                    oi_delta_pct = (oi_now - oi_ref) / oi_ref * 100.0

        funding_factor = -float(np.tanh(funding_deviation)) if funding_deviation is not None else 0.0
        oi_factor = 0.0
        if oi_delta_pct is not None:
            oi_factor = math.copysign(
                math.tanh(abs(oi_delta_pct) / oi_delta_scale_pct),
                1.0 if price_momentum >= 0 else -1.0,
            )
        normalised = float(np.clip(0.6 * funding_factor + 0.4 * oi_factor, -1.0, 1.0))
        return DerivativeComponent(
            funding_rate=funding_rate,
            funding_deviation=funding_deviation,
            open_interest=oi_now,
            open_interest_delta_pct=oi_delta_pct,
            long_short_ratio=latest.long_short_ratio,
            normalised=normalised,
        )

    # ----------------------------------------------------------- confluence
    def compute_confluence(
        self,
        symbol: str,
        bars: Sequence[OHLCVBar],
        social: Sequence[SocialObservation],
        derivatives: Sequence[DerivativeObservation],
        *,
        low_liquidity_volume_threshold: float = 1_000.0,
        volatility_window: int = 30,
        periods_per_year: float = VOLATILITY_ANNUALISATION,
        now: Optional[datetime] = None,
    ) -> ConfluenceResult:
        """Bounded multi-factor confluence score ``S in [-100, +100]``.

        ``S = 100 * tanh(1.4 * (0.35*T + 0.35*E + 0.30*D)) * liquidity_shrink``

        * ``T`` - technical momentum (35 %): RSI displacement + MACD state,
        * ``E`` - sentiment velocity (35 %): weighted polarity, slope,
          divergence detection,
        * ``D`` - derivative dynamics (30 %): funding deviation + OI delta.

        The outer ``tanh`` guarantees strict boundedness even for extreme
        inputs; the liquidity shrink factor pulls scores toward zero when
        median quote volume is below ``low_liquidity_volume_threshold``.

        Warnings are attached for every degradation applied so downstream
        consumers can render data-quality badges in the terminal UI.
        """
        now = now or datetime.now(timezone.utc)
        warnings: List[str] = []

        technical = self.compute_technical(
            bars, volatility_window=volatility_window, periods_per_year=periods_per_year
        )
        if technical.rsi is None or technical.macd is None:
            warnings.append("insufficient_price_history")

        price_series: List[Tuple[datetime, float]] = [
            (bar.timestamp, bar.close) for bar in bars[-400:]
        ]
        sentiment = self.compute_sentiment(social, price_series, now=now)
        if sentiment.sample_size == 0:
            warnings.append("no_sentiment_samples")

        closes = [bar.close for bar in bars]
        returns = self.log_returns(closes)
        if returns.size >= 12:
            price_momentum = float(returns[-12:].sum())
        elif returns.size:
            price_momentum = float(returns.sum())
        else:
            price_momentum = 0.0
        derivative = self.compute_derivative(derivatives, price_momentum=price_momentum)
        if derivative.funding_rate is None:
            warnings.append("no_funding_data")

        blended = (
            WEIGHT_TECHNICAL * technical.normalised
            + WEIGHT_SENTIMENT * sentiment.normalised
            + WEIGHT_DERIVATIVE * derivative.normalised
        )

        # ------------------------------------------------ low-liquidity guard
        volumes = [bar.volume for bar in bars if np.isfinite(bar.volume)]
        liquidity_shrink = 1.0
        if volumes:
            median_volume = float(np.median(volumes))
            if median_volume < low_liquidity_volume_threshold:
                # Continuous shrink: 0.5 at the threshold, -> 0 as volume -> 0.
                liquidity_shrink = float(
                    np.clip(
                        0.5 * median_volume / max(low_liquidity_volume_threshold, EPS), 0.0, 1.0
                    )
                )
                warnings.append("low_liquidity")

        score = float(100.0 * math.tanh(1.4 * blended) * liquidity_shrink)

        # ------------------------------------------------------------ confidence
        confidence_factors = 0.0
        confidence_terms = 0
        if technical.rsi is not None and technical.macd is not None:
            confidence_factors += 1.0
            confidence_terms += 1
        if sentiment.sample_size >= 20:
            confidence_factors += min(1.0, sentiment.sample_size / 100.0)
            confidence_terms += 1
        elif sentiment.sample_size > 0:
            confidence_factors += 0.3 * min(1.0, sentiment.sample_size / 20.0)
            confidence_terms += 1
        if derivative.funding_rate is not None:
            confidence_factors += 1.0
            confidence_terms += 1
        confidence = confidence_factors / confidence_terms if confidence_terms else 0.0

        return ConfluenceResult(
            symbol=symbol,
            score=score,
            regime=self.regime_of(score),
            confidence=float(np.clip(confidence, 0.0, 1.0)),
            technical=technical,
            sentiment=sentiment,
            derivative=derivative,
            warnings=tuple(warnings),
            computed_at=now,
        )

    @staticmethod
    def regime_of(score: float) -> str:
        """Map the bounded score onto a discrete market regime.

        ``|S| < 20`` -> ``neutral``; ``S >= 20`` -> ``risk_on``;
        ``S <= -20`` -> ``risk_off``.
        """
        if score >= CONFIDENCE_REGIME_THRESHOLD:
            return "risk_on"
        if score <= -CONFIDENCE_REGIME_THRESHOLD:
            return "risk_off"
        return "neutral"
