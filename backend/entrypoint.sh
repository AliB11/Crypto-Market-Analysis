#!/usr/bin/env bash
# ============================================================================
# backend/entrypoint.sh – Step 6.2
#
# Boot sequence for every backend container:
#   1. Wait for PostgreSQL (health verification loop).
#   2. Apply pending SQL migrations (database/migrate.py).
#   3. Verify Redis connectivity.
#   4. Spawn the microservice(s) for this container's role and supervise them.
#
# Roles (first positional argument or $SERVICE_ROLE):
#   api       -> uvicorn FastAPI gateway (exec'd as PID 1 child)
#   worker    -> celery beat + celery worker (asyncio pool)
#                + market_feed ingestion process
#                + social_ingestion ingestion process
# ============================================================================
set -euo pipefail

ROLE="${1:-${SERVICE_ROLE:-api}}"
log() { printf '[entrypoint] %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

BACKEND_DIR="$(cd "$(dirname "$0")" && pwd)"
export PYTHONPATH="${BACKEND_DIR}:${PYTHONPATH:-}"

# ---------------------------------------------------------------------------
# 1. Wait for PostgreSQL
# ---------------------------------------------------------------------------
wait_for_postgres() {
    local attempts=0
    until python - <<'PY' >/dev/null 2>&1
import asyncio, asyncpg, os
async def main():
    conn = await asyncpg.connect(
        dsn=f"postgresql://{os.environ.get('POSTGRES_USER','crypto')}:"
            f"{os.environ.get('POSTGRES_PASSWORD','crypto')}@"
            f"{os.environ.get('POSTGRES_HOST','localhost')}:"
            f"{os.environ.get('POSTGRES_PORT','5432')}/"
            f"{os.environ.get('POSTGRES_DB','crypto_intel')}"
    )
    await conn.close()
asyncio.run(main())
PY
    do
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 60 ]; then
            log "FATAL: PostgreSQL did not become ready in 60 attempts"
            exit 1
        fi
        log "waiting for PostgreSQL ($attempts/60)..."
        sleep 2
    done
    log "PostgreSQL is reachable"
}

# ---------------------------------------------------------------------------
# 3. Wait for Redis
# ---------------------------------------------------------------------------
wait_for_redis() {
    local attempts=0
    until python - <<'PY' >/dev/null 2>&1
import asyncio, os
import redis.asyncio as aioredis
async def main():
    client = aioredis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379/0"))
    await client.ping()
    await client.aclose()
asyncio.run(main())
PY
    do
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 60 ]; then
            log "FATAL: Redis did not become ready in 60 attempts"
            exit 1
        fi
        log "waiting for Redis ($attempts/60)..."
        sleep 2
    done
    log "Redis is reachable"
}

# ---------------------------------------------------------------------------
# Supervised child process helper: restart on non-zero exit, forward signals.
# ---------------------------------------------------------------------------
PIDS=()

spawn() { # spawn <name> <command...>
    local name="$1"; shift
    (
        while true; do
            log "starting ${name}"
            if "$@"; then
                log "${name} exited cleanly"
                exit 0
            else
                log "${name} exited with code $? – restarting in 5s"
            fi
            sleep 5
        done
    ) &
    PIDS+=("$!")
}

shutdown() {
    log "shutdown signal received – terminating children"
    for pid in "${PIDS[@]:-}"; do
        kill -TERM "$pid" 2>/dev/null || true
    done
    wait || true
    exit 0
}
trap shutdown SIGTERM SIGINT

# ---------------------------------------------------------------------------
# Boot sequence
# ---------------------------------------------------------------------------
log "role=${ROLE}"

wait_for_postgres
log "applying database migrations"
python -m database.migrate
log "migrations complete"

wait_for_redis

case "$ROLE" in
    api)
        log "starting FastAPI gateway (uvicorn, ${API_WORKERS:-2} workers)"
        exec uvicorn main:app \
            --host "${API_HOST:-0.0.0.0}" \
            --port "${API_PORT:-8000}" \
            --workers "${API_WORKERS:-2}" \
            --proxy-headers \
            --forwarded-allow-ips '*'
        ;;
    worker)
        log "starting analytics worker stack"
        spawn "celery-beat"  celery -A workers.celery_app beat --loglevel=INFO
        spawn "celery-worker" celery -A workers.celery_app worker \
                --pool=asyncio --concurrency="${CELERY_CONCURRENCY:-16}" \
                --loglevel=INFO --max-tasks-per-child=200
        spawn "market-feed" python -m workers.market_feed
        spawn "social-ingestion" python -m workers.social_ingestion
        log "worker stack up (beat, analytics, market feed, social ingestion)"
        wait
        ;;
    *)
        log "unknown role '${ROLE}' (expected 'api' or 'worker')"
        exit 1
        ;;
esac
