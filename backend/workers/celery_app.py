"""Celery application for the analytics worker.

Runs with **event loop concurrency** via ``celery-aio-pool``::

    celery -A workers.celery_app worker --pool=asyncio --concurrency=32
    celery -A workers.celery_app beat

Beat schedule
-------------
* ``refresh-confluence`` – recompute the multi-factor confluence score for
  every watchlist symbol every 60 seconds, persist a snapshot into the
  ``signal_snapshots`` hypertable and broadcast it on ``signals:{SYMBOL}``.
* ``enforce-retention`` – drop chunks beyond the configured retention
  windows so storage stays bounded (TimescaleDB ``drop_chunks``).
"""

from __future__ import annotations

import logging
import os

from celery import Celery
from celery.schedules import crontab

from config import get_settings

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-8s %(name)s :: %(message)s",
)

settings = get_settings()

celery_app = Celery(
    "crypto_intel",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
    include=["workers.tasks"],
)

celery_app.conf.update(
    # -- event loop pool semantics -------------------------------------------
    task_default_queue="analytics",
    worker_prefetch_multiplier=1,          # fair dispatch for long I/O tasks
    task_acks_late=True,                   # survive worker crashes safely
    task_reject_on_worker_lost=True,
    # -- serialisation --------------------------------------------------------
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    # -- reliability ----------------------------------------------------------
    result_expires=3600,
    broker_connection_retry_on_startup=True,
    worker_max_tasks_per_child=500,        # recycle to bound RSS growth
    # -- beat -----------------------------------------------------------------
    beat_schedule={
        "refresh-confluence": {
            "task": "workers.tasks.refresh_confluence",
            "schedule": 60.0,
            "options": {"expires": 55},
        },
        "enforce-retention": {
            "task": "workers.tasks.enforce_retention",
            "schedule": crontab(hour=3, minute=0),
        },
    },
)
