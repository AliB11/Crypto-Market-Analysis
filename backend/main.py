"""Enterprise FastAPI gateway (Step 4).

Responsibilities
----------------
* **Middleware** – explicit CORS allowlist, security headers, distributed
  rate limiting (slowapi backed by Redis so limits hold across Uvicorn
  workers) and per-request tracing.
* **REST API** – versioned under ``/api/v1``:

  - ``GET /api/v1/market/ohlcv/{symbol}`` – historical series with dynamic
    bucketing (5m / 1h / 1d).
  - ``GET /api/v1/sentiment/divergence/{symbol}`` – sentiment-to-price
    divergence signals.
  - ``GET /api/v1/analytics/composite-score/{symbol}`` – composite
    confluence score with full technical breakdown.

* **WebSocket gateway** – ``WS /ws/live/{symbol}`` multiplexes live price
  ticks, recomputed signals and high-impact social alerts.

* **Lifecycle** – asyncpg pool + Redis connections established in lifespan
  startup (with retries), drained on shutdown.  In test mode the lifespan
  can be disabled via ``TESTING=1`` so the suite runs without services.

Run with::

    uvicorn main:app --host 0.0.0.0 --port 8000 --workers 2
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.exceptions import HTTPException as StarletteHTTPException

from cache import RedisBus, redis_bus
from config import Settings, get_settings
from db import Database, database
from middleware import RequestTracingMiddleware, SecurityHeadersMiddleware
from routers import analytics, market, sentiment
from ws import StreamHub, register_ws_routes

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-8s %(name)s :: %(message)s",
)
logger = logging.getLogger("api")

TESTING = os.getenv("TESTING", "0") == "1"


# --------------------------------------------------------------------- limiter
def _build_limiter(settings: Settings) -> Limiter:
    if settings.RATELIMIT_ENABLED and not TESTING:
        # Redis-backed storage keeps limits consistent across workers.
        return Limiter(
            key_func=get_remote_address,
            default_limits=[settings.RATELIMIT_DEFAULT],
            storage_uri=settings.REDIS_URL,
        )
    disabled = Limiter(key_func=get_remote_address, enabled=False)
    return disabled


limiter = _build_limiter(get_settings())


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Establish and drain service connections (skipped under test)."""
    settings = get_settings()
    if TESTING:
        # Tests may have already injected fakes onto app.state – keep them.
        app.state.database = getattr(app.state, "database", database)
        app.state.redis_bus = getattr(app.state, "redis_bus", redis_bus)
        app.state.stream_hub = getattr(app.state, "stream_hub", StreamHub(redis_bus, settings))
        yield
        return

    await database.connect()
    await redis_bus.connect()
    app.state.database = database
    app.state.redis_bus = redis_bus
    app.state.stream_hub = StreamHub(redis_bus, settings)
    logger.info("API gateway ready (env=%s, watchlist=%s)", settings.ENVIRONMENT, settings.SYMBOLS)
    try:
        yield
    finally:
        await redis_bus.close()
        await database.close()
        logger.info("API gateway shut down cleanly")


def create_app() -> FastAPI:
    """Application factory (kept separate for testability)."""
    settings = get_settings()
    app = FastAPI(
        title="Crypto Intelligence Terminal API",
        description=(
            "Real-time cryptocurrency technical, sentiment and derivative "
            "intelligence platform: TimescaleDB time-series storage, Redis "
            "pub/sub streaming and transformer-based NLP."
        ),
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/docs" if not settings.is_production else None,
        redoc_url=None,
    )

    # ----------------------------------------------------------- middleware
    # NOTE: order matters - the last added middleware runs first.
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(RequestTracingMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID"],
        max_age=600,
    )
    try:
        from slowapi.middleware import SlowAPIMiddleware

        app.state.limiter = limiter
        app.add_middleware(SlowAPIMiddleware)
    except Exception:  # pragma: no cover - middleware optional in tests
        logger.warning("slowapi middleware disabled")

    # -------------------------------------------------------------- routers
    app.include_router(market.router)
    app.include_router(sentiment.router)
    app.include_router(analytics.router)
    register_ws_routes(app)

    # ------------------------------------------------------ exception handlers
    @app.exception_handler(RateLimitExceeded)
    async def _rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            content=jsonable_encoder(
                {
                    "error": "rate_limit_exceeded",
                    "detail": f"Rate limit exceeded: {exc.detail}. Retry later.",
                    "request_id": getattr(request.state, "request_id", None),
                }
            ),
            headers={"Retry-After": "30"},
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content=jsonable_encoder(
                {
                    "error": "validation_error",
                    "detail": "Request parameters failed validation.",
                    "errors": exc.errors(),
                    "request_id": getattr(request.state, "request_id", None),
                }
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=jsonable_encoder(
                {
                    "error": f"http_{exc.status_code}",
                    "detail": exc.detail,
                    "request_id": getattr(request.state, "request_id", None),
                }
            ),
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(Exception)
    async def _unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled exception on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=jsonable_encoder(
                {
                    "error": "internal_error",
                    "detail": "An unexpected error occurred. The incident was logged.",
                    "request_id": getattr(request.state, "request_id", None),
                }
            ),
        )

    # ------------------------------------------------------------- health
    @app.get("/healthz", tags=["ops"], summary="Liveness probe")
    async def healthz() -> dict:
        return {"status": "ok", "service": "backend-api"}

    @app.get("/readyz", tags=["ops"], summary="Readiness probe (DB + Redis)")
    async def readyz() -> JSONResponse:
        checks: dict[str, str] = {}
        healthy = True
        try:
            if not TESTING:
                await database.pool.fetchval("SELECT 1")
            checks["postgres"] = "ok"
        except Exception as exc:
            checks["postgres"] = f"error: {exc.__class__.__name__}"
            healthy = False
        try:
            if not TESTING:
                await redis_bus.client.ping()
            checks["redis"] = "ok"
        except Exception as exc:
            checks["redis"] = f"error: {exc.__class__.__name__}"
            healthy = False
        return JSONResponse(
            status_code=status.HTTP_200_OK if healthy else status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"status": "ready" if healthy else "degraded", "checks": checks},
        )

    return app


app = create_app()


if __name__ == "__main__":  # pragma: no cover - local dev entrypoint
    import uvicorn

    uvicorn.run(
        "main:app",
        host=get_settings().API_HOST,
        port=get_settings().API_PORT,
        reload=not get_settings().is_production,
    )
