-- ============================================================================
-- Crypto Intelligence Terminal – initial TimescaleDB schema (Step 1.2)
-- ============================================================================
-- Idempotent: safe to re-run (CREATE ... IF NOT EXISTS everywhere).
-- Applied automatically by:
--   * the timescaledb container on first volume init (docker-entrypoint-initdb.d)
--   * backend/entrypoint.sh -> database/migrate.py on every service boot
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------------
-- market_ohlcv : 1-minute base-grain candle hypertable
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_ohlcv (
    timestamp   TIMESTAMPTZ     NOT NULL,
    symbol      TEXT            NOT NULL,               -- base asset, e.g. 'BTC'
    resolution  TEXT            NOT NULL DEFAULT '1m',  -- base grain '1m'
    open        DOUBLE PRECISION NOT NULL CHECK (open  >= 0),
    high        DOUBLE PRECISION NOT NULL CHECK (high >= 0),
    low         DOUBLE PRECISION NOT NULL CHECK (low  >= 0),
    close       DOUBLE PRECISION NOT NULL CHECK (close >= 0),
    volume      DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (volume >= 0),
    PRIMARY KEY (symbol, resolution, timestamp)
);

SELECT create_hypertable(
    'market_ohlcv', 'timestamp',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists       => TRUE
);

-- Sub-millisecond symbol range lookups (newest first).
CREATE INDEX IF NOT EXISTS idx_market_ohlcv_symbol_ts
    ON market_ohlcv (symbol, resolution, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_market_ohlcv_ts
    ON market_ohlcv (timestamp DESC);

-- ---------------------------------------------------------------------------
-- social_sentiment : classified social posts hypertable
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS social_sentiment (
    timestamp             TIMESTAMPTZ     NOT NULL,
    platform              TEXT            NOT NULL CHECK (platform IN ('twitter', 'reddit')),
    symbol                TEXT            NOT NULL,
    external_id           TEXT            NOT NULL,      -- '{platform}:{post_id}'
    author                TEXT            NOT NULL,
    author_reach          BIGINT          NOT NULL DEFAULT 0,
    engagement_metrics    JSONB           NOT NULL DEFAULT '{}'::jsonb,
    cleaned_text          TEXT            NOT NULL,
    sentiment_polarity    DOUBLE PRECISION NOT NULL
                          CHECK (sentiment_polarity BETWEEN -1.0 AND 1.0),
    sentiment_confidence  DOUBLE PRECISION NOT NULL
                          CHECK (sentiment_confidence BETWEEN 0.0 AND 1.0),
    author_weight         DOUBLE PRECISION NOT NULL DEFAULT 0,  -- log(1+eng+reach)
    PRIMARY KEY (timestamp, external_id)
);

SELECT create_hypertable(
    'social_sentiment', 'timestamp',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists       => TRUE
);

CREATE INDEX IF NOT EXISTS idx_social_sentiment_symbol_ts
    ON social_sentiment (symbol, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_social_sentiment_symbol_polarity
    ON social_sentiment (symbol, sentiment_polarity, timestamp DESC);

-- ---------------------------------------------------------------------------
-- derivative_metrics : funding / open interest / long-short hypertable
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS derivative_metrics (
    timestamp         TIMESTAMPTZ      NOT NULL,
    symbol            TEXT             NOT NULL,
    funding_rate      DOUBLE PRECISION,            -- fraction per 8h (nullable)
    open_interest     DOUBLE PRECISION,            -- base-asset contracts (nullable)
    long_short_ratio  DOUBLE PRECISION,            -- global account ratio (nullable)
    PRIMARY KEY (symbol, timestamp)
);

SELECT create_hypertable(
    'derivative_metrics', 'timestamp',
    chunk_time_interval => INTERVAL '30 days',
    if_not_exists       => TRUE
);

CREATE INDEX IF NOT EXISTS idx_derivative_metrics_symbol_ts
    ON derivative_metrics (symbol, timestamp DESC);

-- ---------------------------------------------------------------------------
-- signal_snapshots : persisted confluence scores (hypertable, bonus table)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signal_snapshots (
    timestamp              TIMESTAMPTZ      NOT NULL,
    symbol                 TEXT             NOT NULL,
    score                  DOUBLE PRECISION NOT NULL CHECK (score BETWEEN -100 AND 100),
    technical_component    DOUBLE PRECISION NOT NULL,
    sentiment_component    DOUBLE PRECISION NOT NULL,
    derivative_component   DOUBLE PRECISION NOT NULL,
    confidence             DOUBLE PRECISION NOT NULL,
    regime                 TEXT             NOT NULL,
    breakdown              JSONB            NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (symbol, timestamp)
);

SELECT create_hypertable(
    'signal_snapshots', 'timestamp',
    chunk_time_interval => INTERVAL '30 days',
    if_not_exists       => TRUE
);

CREATE INDEX IF NOT EXISTS idx_signal_snapshots_symbol_ts
    ON signal_snapshots (symbol, timestamp DESC);

-- ---------------------------------------------------------------------------
-- Migration bookkeeping (used by database/migrate.py)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version)
VALUES ('0001_initial_schema')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Retention policies (defense-in-depth; celery task also enforces drop_chunks)
-- ---------------------------------------------------------------------------
-- TimescaleDB community supports add_retention_policy since 2.2:
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_retention' AND hypertable_name = 'market_ohlcv'
    ) THEN
        PERFORM add_retention_policy('market_ohlcv', INTERVAL '180 days');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_retention' AND hypertable_name = 'social_sentiment'
    ) THEN
        PERFORM add_retention_policy('social_sentiment', INTERVAL '180 days');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_retention' AND hypertable_name = 'derivative_metrics'
    ) THEN
        PERFORM add_retention_policy('derivative_metrics', INTERVAL '180 days');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_retention' AND hypertable_name = 'signal_snapshots'
    ) THEN
        PERFORM add_retention_policy('signal_snapshots', INTERVAL '365 days');
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'retention policies skipped: %', SQLERRM;
END $$;
