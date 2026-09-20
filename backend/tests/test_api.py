"""API gateway test suite (Step 6.1 – test_api.py).

Checks route status codes, payload validation, error handling, security
headers and the multiplexed WebSocket gateway – all against in-memory
repository fakes (see ``conftest.api_client``).
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest


# ===========================================================================
# Health & discovery
# ===========================================================================
class TestHealthRoutes:
    def test_healthz_returns_ok(self, api_client):
        response = api_client.get("/healthz")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_readyz_reports_checks(self, api_client):
        response = api_client.get("/readyz")
        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] in {"ready", "degraded"}
        assert "postgres" in payload["checks"] and "redis" in payload["checks"]

    def test_security_headers_present(self, api_client):
        response = api_client.get("/healthz")
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["X-Frame-Options"] == "DENY"
        assert "strict-origin-when-cross-origin" in response.headers["Referrer-Policy"]
        assert "max-age" in response.headers["Strict-Transport-Security"]

    def test_request_id_echoed_and_generated(self, api_client):
        response = api_client.get("/healthz", headers={"X-Request-ID": "trace-abc-123"})
        assert response.headers["X-Request-ID"] == "trace-abc-123"
        response = api_client.get("/healthz")
        assert len(response.headers["X-Request-ID"]) >= 8


class TestWatchlistRoute:
    def test_symbols_endpoint(self, api_client):
        response = api_client.get("/api/v1/market/symbols")
        assert response.status_code == 200
        payload = response.json()
        assert payload["quote"] == "USDT"
        symbols = {entry["symbol"] for entry in payload["symbols"]}
        assert {"BTC", "ETH"} <= symbols


# ===========================================================================
# OHLCV
# ===========================================================================
class TestOHLCVRoute:
    def test_default_resolution_returns_candles(self, api_client):
        response = api_client.get("/api/v1/market/ohlcv/BTC")
        assert response.status_code == 200
        payload = response.json()
        assert payload["symbol"] == "BTCUSDT"
        assert payload["resolution"] == "5m"
        assert payload["count"] == len(payload["candles"]) > 0
        candle = payload["candles"][-1]
        for key in ("time", "open", "high", "low", "close", "volume"):
            assert key in candle
        assert candle["high"] >= candle["low"]

    @pytest.mark.parametrize("resolution", ["5m", "1h", "1d"])
    def test_all_resolutions_accepted(self, api_client, resolution):
        response = api_client.get(f"/api/v1/market/ohlcv/BTC?resolution={resolution}")
        assert response.status_code == 200
        assert response.json()["resolution"] == resolution

    def test_invalid_resolution_rejected_422(self, api_client):
        response = api_client.get("/api/v1/market/ohlcv/BTC?resolution=7m")
        assert response.status_code == 422
        payload = response.json()
        assert payload["error"] == "validation_error"

    def test_limit_bounds_enforced(self, api_client):
        assert api_client.get("/api/v1/market/ohlcv/BTC?limit=5").status_code == 422
        assert api_client.get("/api/v1/market/ohlcv/BTC?limit=99999").status_code == 422

    def test_unknown_symbol_404(self, api_client):
        response = api_client.get("/api/v1/market/ohlcv/PIGEON")
        assert response.status_code == 404
        payload = response.json()
        assert "not part of the monitored watchlist" in payload["detail"]

    def test_lowercase_symbol_normalised(self, api_client):
        response = api_client.get("/api/v1/market/ohlcv/btc")
        assert response.status_code == 200
        assert response.json()["symbol"] == "BTCUSDT"


# ===========================================================================
# Divergence
# ===========================================================================
class TestDivergenceRoute:
    def test_divergence_shape(self, api_client):
        response = api_client.get("/api/v1/sentiment/divergence/BTC?window_hours=48")
        assert response.status_code == 200
        payload = response.json()
        assert payload["symbol"] == "BTCUSDT"
        assert payload["window_hours"] == 48
        assert isinstance(payload["signals"], list)

    def test_window_bounds_validated(self, api_client):
        assert (
            api_client.get("/api/v1/sentiment/divergence/BTC?window_hours=1").status_code == 422
        )
        assert (
            api_client.get("/api/v1/sentiment/divergence/BTC?window_hours=99999").status_code == 422
        )

    def test_unknown_symbol_404(self, api_client):
        assert api_client.get("/api/v1/sentiment/divergence/NOPE").status_code == 404


# ===========================================================================
# Composite score
# ===========================================================================
class TestCompositeScoreRoute:
    def test_composite_score_payload(self, api_client):
        response = api_client.get("/api/v1/analytics/composite-score/BTC")
        assert response.status_code == 200
        payload = response.json()
        assert payload["symbol"] == "BTCUSDT"
        assert -100.0 <= payload["score"] <= 100.0
        assert payload["regime"] in {"risk_on", "neutral", "risk_off"}
        assert 0.0 <= payload["confidence"] <= 1.0
        for component in ("technical", "sentiment", "derivative"):
            assert -1.0 <= payload[component] <= 1.0
        assert payload["technical_detail"]["rsi"] is not None
        assert 0.0 <= payload["technical_detail"]["rsi"] <= 100.0
        assert payload["derivative_detail"]["funding_rate"] is not None
        assert isinstance(payload["warnings"], list)
        assert "computed_at" in payload

    def test_lookback_bounds(self, api_client):
        assert (
            api_client.get("/api/v1/analytics/composite-score/BTC?lookback_hours=1").status_code
            == 422
        )

    def test_unknown_symbol_404(self, api_client):
        assert api_client.get("/api/v1/analytics/composite-score/DODO").status_code == 404

    def test_low_liquidity_symbol_reports_warning(self, api_client):
        from conftest import FakeMarketRepo, make_bars
        from deps import get_market_repo

        from main import app

        app.dependency_overrides[get_market_repo] = lambda: FakeMarketRepo(
            make_bars(volume=10.0, seed=3)
        )
        try:
            response = api_client.get("/api/v1/analytics/composite-score/BTC")
            assert response.status_code == 200
            assert "low_liquidity" in response.json()["warnings"]
        finally:
            # restore the fixture default for subsequent tests in this session
            from conftest import FakeDerivativeRepo, FakeMarketRepo as _FMR, FakeSentimentRepo, make_bars as _mb, make_derivatives as _md
            from deps import get_derivative_repo, get_sentiment_repo

            app.dependency_overrides[get_market_repo] = lambda: _FMR(_mb())
            app.dependency_overrides[get_derivative_repo] = lambda: FakeDerivativeRepo(_md())
            app.dependency_overrides[get_sentiment_repo] = lambda: FakeSentimentRepo()


# ===========================================================================
# WebSocket gateway
# ===========================================================================
class TestWebSocketGateway:
    def test_unknown_symbol_rejected(self, api_client):
        with api_client.websocket_connect("/ws/live/PIGEON") as websocket:
            message = json.loads(websocket.receive_text())
            assert message["channel"] == "status"
            assert message["type"] == "error"

    def test_multiplexed_frames_streamed(self, api_client, fake_hub):
        frames = [
            {
                "channel": "price",
                "type": "candle",
                "symbol": "BTC",
                "data": {"close": 51_250.0, "time": 1_700_000_000, "volume": 40.0},
            },
            {
                "channel": "signal",
                "type": "confluence",
                "symbol": "BTC",
                "data": {"score": 42.5, "regime": "risk_on"},
            },
            {
                "channel": "sentiment",
                "type": "alert",
                "symbol": "ETH",  # other symbol – must be filtered out
                "data": {"polarity": -0.8},
            },
            {
                "channel": "sentiment",
                "type": "alert",
                "symbol": "BTC",
                "data": {"polarity": -0.9, "confidence": 0.97, "text": "bearish"},
            },
        ]
        for frame in frames:
            fake_hub.push(frame)

        with api_client.websocket_connect("/ws/live/BTC") as websocket:
            received = []
            # snapshot frame + the 3 matching live frames
            for _ in range(4):
                received.append(json.loads(websocket.receive_text()))

            channels = [message["channel"] for message in received]
            assert channels[0] == "status"  # initial snapshot
            assert "price" in channels
            assert "signal" in channels
            assert "sentiment" in channels

            sentiment_frames = [m for m in received if m["channel"] == "sentiment"]
            assert len(sentiment_frames) == 1
            assert sentiment_frames[0]["symbol"] == "BTC"
            assert sentiment_frames[0]["data"]["polarity"] == pytest.approx(-0.9)

            price_frame = next(m for m in received if m["channel"] == "price")
            assert price_frame["data"]["close"] == pytest.approx(51_250.0)
            assert "server_ts" in price_frame

    def test_frame_envelope_fields(self, api_client, fake_hub):
        fake_hub.push(
            {"channel": "price", "type": "tick", "symbol": "BTC", "data": {"price": 42.0}}
        )
        with api_client.websocket_connect("/ws/live/BTC") as websocket:
            websocket.receive_text()  # snapshot
            frame = json.loads(websocket.receive_text())
            assert set(frame) >= {"channel", "type", "symbol", "data", "server_ts"}
            assert frame["type"] == "tick"


# ===========================================================================
# CORS
# ===========================================================================
class TestCors:
    def test_preflight_from_allowed_origin(self, api_client):
        response = api_client.options(
            "/api/v1/market/ohlcv/BTC",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "http://localhost:3000"

    def test_cors_headers_on_actual_response(self, api_client):
        response = api_client.get(
            "/api/v1/market/ohlcv/BTC", headers={"Origin": "http://localhost:3000"}
        )
        assert response.headers.get("access-control-allow-origin") == "http://localhost:3000"
