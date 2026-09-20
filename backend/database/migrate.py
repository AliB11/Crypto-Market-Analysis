"""Minimal, dependency-free SQL migration runner.

Applies every ``database/migrations/*.sql`` in lexical order exactly once,
tracking applied versions in the ``schema_migrations`` table.  ``init.sql``
is kept as the canonical first migration (0001) so both the Docker
initialisation path and this runner converge on the same schema state.

Run standalone::

    python -m database.migrate          # applies pending migrations
    python -m database.migrate --check  # exit 2 if migrations are pending
"""

from __future__ import annotations

import asyncio
import logging
import re
import sys
from pathlib import Path
from typing import Iterable, List, Tuple

import asyncpg

from config import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(name)s :: %(message)s")
logger = logging.getLogger("migrate")

MIGRATIONS_DIR = Path(__file__).parent / "migrations"

# Split multi-statement SQL on semicolons that terminate a statement.
_COMMENT_RE = re.compile(r"--[^\n]*")


def _split_statements(sql: str) -> List[str]:
    """Split a script into executable statements, preserving $$ blocks."""
    statements: List[str] = []
    buffer: List[str] = []
    in_dollar_block = False
    for line in sql.splitlines():
        stripped = _COMMENT_RE.sub("", line)
        buffer.append(line)
        if stripped.count("$$") % 2 == 1:
            in_dollar_block = not in_dollar_block
        if not in_dollar_block and stripped.strip().endswith(";"):
            statement = "\n".join(buffer).strip()
            if statement:
                statements.append(statement)
            buffer = []
    if buffer:
        tail = "\n".join(buffer).strip()
        if tail:
            statements.append(tail)
    return statements


def discover_migrations() -> List[Tuple[str, Path]]:
    """Return ``(version, path)`` pairs sorted by version identifier."""
    migrations: List[Tuple[str, Path]] = []
    if MIGRATIONS_DIR.exists():
        migrations.extend(
            (path.name, path) for path in sorted(MIGRATIONS_DIR.glob("*.sql"))
        )
    return migrations


async def apply_migrations(check_only: bool = False) -> List[str]:
    """Apply pending migrations; returns the list of applied versions."""
    settings = get_settings()
    conn: asyncpg.Connection = await asyncpg.connect(dsn=settings.postgres_dsn)
    applied: List[str] = []
    try:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version     TEXT PRIMARY KEY,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        existing = {
            row["version"] for row in await conn.fetch("SELECT version FROM schema_migrations")
        }
        pending = [(v, p) for v, p in discover_migrations() if v not in existing]
        if check_only:
            if pending:
                logger.error("pending migrations: %s", [v for v, _ in pending])
                sys.exit(2)
            logger.info("schema is up to date")
            return []

        for version, path in pending:
            logger.info("applying migration %s", version)
            statements = _split_statements(path.read_text(encoding="utf-8"))
            async with conn.transaction():
                for statement in statements:
                    await conn.execute(statement)
                await conn.execute(
                    "INSERT INTO schema_migrations (version) VALUES ($1) "
                    "ON CONFLICT (version) DO NOTHING",
                    version,
                )
            applied.append(version)
        if not applied:
            logger.info("schema is up to date (no pending migrations)")
        return applied
    finally:
        await conn.close()


def bootstrap_from_init_sql() -> None:
    """Mirror ``init.sql`` into the versioned migrations directory once.

    Keeps a single source of truth: ``init.sql`` stays canonical (also used
    by the postgres container's first-boot init), and the runner sees it as
    version ``0001_init.sql``.
    """
    MIGRATIONS_DIR.mkdir(parents=True, exist_ok=True)
    init_sql = Path(__file__).parent / "init.sql"
    target = MIGRATIONS_DIR / "0001_init.sql"
    if init_sql.exists() and not target.exists():
        target.write_text(init_sql.read_text(encoding="utf-8"), encoding="utf-8")
        logger.info("seeded migration 0001_init.sql from init.sql")


async def _main() -> None:
    check_only = "--check" in sys.argv
    bootstrap_from_init_sql()
    applied = await apply_migrations(check_only=check_only)
    if applied:
        logger.info("applied %d migration(s): %s", len(applied), applied)


if __name__ == "__main__":
    asyncio.run(_main())
