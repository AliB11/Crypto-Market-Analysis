# syntax=docker/dockerfile:1
# ============================================================================
# Backend image – two runtime profiles from one build context:
#   build-arg PROFILE=api     -> FastAPI + Uvicorn (default)
#   build-arg PROFILE=worker  -> Celery + ingestion + NLP/transformers
# ============================================================================
FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential libpq-dev curl tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ------------------------------------------------------------- dependencies
ARG PROFILE=api
ENV PROFILE=${PROFILE}
COPY requirements.txt requirements-worker.txt ./
RUN pip install --upgrade pip \
 && pip install -r requirements.txt \
 && if [ "$PROFILE" = "worker" ]; then pip install -r requirements-worker.txt; fi

# ------------------------------------------------------------ application
COPY . /app/backend
ENV PYTHONPATH=/app/backend \
    PATH="/app/backend:${PATH}"
RUN chmod +x /app/backend/entrypoint.sh

EXPOSE 8000

# API profile serves /healthz; worker profiles are supervised by the
# entrypoint itself (celery inspect is heavy – a process-alive check suffices).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD if [ "$PROFILE" = "api" ]; then curl -fsS http://localhost:8000/healthz || exit 1; fi

ENTRYPOINT ["/usr/bin/tini", "--", "/app/backend/entrypoint.sh"]
CMD ["api"]
