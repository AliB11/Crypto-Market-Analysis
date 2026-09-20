"""HTTP middleware stack: request tracing + security headers.

Two lightweight ASGI middlewares (no third-party frameworks) provide:

* **Request tracing** – every request receives an ``X-Request-ID`` (honouring
  an inbound header from the upstream proxy) which is echoed on the response
  and attached to all structured log lines for that request.
* **Security headers** – ``X-Content-Type-Options``, ``X-Frame-Options``,
  ``Referrer-Policy``, ``Permissions-Policy`` and ``Strict-Transport-Security``
  applied to every response.

A context variable carries the request id so exception handlers can include
it in error payloads without threading it through every function signature.
"""

from __future__ import annotations

import logging
import time
import uuid
from contextvars import ContextVar

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger("api.request")

request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")

SECURITY_HEADERS: dict[str, str] = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    "X-XSS-Protection": "0",  # modern guidance: disable legacy auditor
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cache-Control": "no-store",
}


class RequestTracingMiddleware(BaseHTTPMiddleware):
    """Assign/propagate ``X-Request-ID`` and emit structured access logs."""

    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:16]
        request_id_ctx.set(request_id)
        request.state.request_id = request_id

        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            duration_ms = (time.perf_counter() - started) * 1000.0
            logger.exception(
                "request_failed method=%s path=%s request_id=%s duration_ms=%.1f",
                request.method,
                request.url.path,
                request_id,
                duration_ms,
            )
            raise
        duration_ms = (time.perf_counter() - started) * 1000.0
        response.headers["X-Request-ID"] = request_id
        logger.info(
            "request_completed method=%s path=%s status=%d duration_ms=%.1f request_id=%s",
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
            request_id,
        )
        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Apply the enterprise security header baseline to every response."""

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        for header, value in SECURITY_HEADERS.items():
            response.headers.setdefault(header, value)
        return response
