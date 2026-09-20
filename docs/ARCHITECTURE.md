# Architecture — Crypto Intelligence Terminal

## 1. Service topology

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            analytics-worker (container)                       │
│                                                                              │
│  market_feed.py            social_ingestion.py         celery worker         │
│  ─────────────────         ─────────────────────        (asyncio pool)        │
│  ccxt.pro WS:              tweepy.AsyncClient:         tasks.py              │
│   • watch_ohlcv 1m          • search_recent_tweets      • refresh_confluence  │
│   • watch_ticker            praw (to_thread):           • enforce_retention   │
│  REST poll:                 • subreddit.new            celery beat:          │
│   • funding rate            pipeline:                   • 60s confluence      │
│   • open interest            sanitize → bot filter      • daily drop_chunks   │
│   • long/short ratio         → W=log(1+eng+reach)                             │
│                             → HF transformer batch                             │
└──────────┬──────────────────────────┬────────────────────────┬───────────────┘
           │ upserts                  │ pub/sub                │ pub/sub + upserts
           ▼                          ▼                        ▼
   ┌───────────────┐          ┌───────────────┐         ┌───────────────┐
   │  timescaledb  │          │     redis     │         │  (timescaledb)│
   │  hypertables  │          │  ticks:{SYM}  │         │  signal_      │
   │               │          │  signals:{SYM}│         │  snapshots    │
   │               │          │  derivs:{SYM} │         └───────────────┘
   │               │          │  sentiment_   │
   │               │          │  stream       │
   └───────▲───────┘          └───────▲───────┘
           │ reads                    │ subscribe
   ┌───────┴──────────────────────────┴──────────────────┐
   │                 backend-api (FastAPI)                │
   │  middleware: tracing → security headers → CORS      │
   │               → slowapi (Redis storage)             │
   │  REST /api/v1/market|sentiment|analytics            │
   │  WS   /ws/live/{symbol}  (multiplexed fan-out)      │
   └──────────────────────────┬──────────────────────────┘
                              │ REST hydration + WS frames
                   ┌──────────▼──────────┐
                   │ frontend (Next.js)  │
                   │ useLiveTerminal →   │
                   │ Zustand → widgets   │
                   └─────────────────────┘
```

## 2. Data model (TimescaleDB hypertables)

| Table | Partition | Chunk interval | Primary key | Purpose |
|---|---|---|---|---|
| `market_ohlcv` | `timestamp` | 7 days | `(symbol, resolution, timestamp)` | 1m base-grain candles |
| `social_sentiment` | `timestamp` | 7 days | `(timestamp, external_id)` | classified social posts |
| `derivative_metrics` | `timestamp` | 30 days | `(symbol, timestamp)` | funding / OI / LSR snapshots |
| `signal_snapshots` | `timestamp` | 30 days | `(symbol, timestamp)` | persisted confluence history |

Composite indices `(symbol, timestamp DESC)` (plus resolution where part of the
PK) give sub-millisecond symbol range scans. Aggregation endpoints use native
`time_bucket` + `first()`/`last()` so 5m/1h/1d views are computed inside the
database from the 1m grain. Retention is enforced both by TimescaleDB retention
jobs (init.sql) and the `enforce_retention` Celery task (`drop_chunks`).

## 3. Redis channel contract

| Channel | Publisher | Frame types |
|---|---|---|
| `ticks:{SYMBOL}` | market_feed | `candle` (partial 1m OHLCV), `tick` (mark price) |
| `derivatives:{SYMBOL}` | market_feed | `snapshot` (funding, OI, LSR) |
| `sentiment_stream` | social_ingestion | `update`, `alert` (|polarity| ≥ 0.45 & confidence ≥ 0.65) |
| `signals:{SYMBOL}` | celery tasks | `confluence` (full serialised result) |

The gateway envelops every frame as:

```json
{"channel": "price", "type": "candle", "symbol": "BTC", "data": {…}, "server_ts": "…"}
```

`sentiment_stream` is global; the gateway filters it server-side per connected
symbol. A `latest:signal:{SYMBOL}` cache (TTL 300s) lets the gateway push an
instant snapshot on WS connect.

## 4. Confluence engine

Pure NumPy suite in `backend/services/quantitative.py` (full mathematical
docstrings in-code):

1. **Technical (35%)** — `clip((RSI−50)/25)` blended 50/50 with
   `tanh(MACD_hist% / 20bps)`; the histogram is normalised by price so the
   signal is scale-invariant from DOGE to BTC.
2. **Sentiment velocity (35%)** — reach-weighted polarity
   (`Σw·p / Σw`, `w = log(1+eng+reach)·confidence`), least-squares slope over
   6 time buckets, and pivot-based divergence bias.
3. **Derivatives (30%)** — contrarian funding deviation `−tanh(f/0.0005)` plus
   OI delta signed by price momentum.
4. **Bounded fusion** — `100·tanh(1.4·blend)·liquidity_shrink`, guaranteed
   within [−100, +100] for any input; regime thresholds at ±20.

Degradation semantics: insufficient history / no social data / missing funding
each produce explicit warnings (`insufficient_price_history`,
`no_sentiment_samples`, `no_funding_data`, `low_liquidity`) surfaced in the UI,
never NaN.

## 5. Reliability patterns

* **Ingestion supervision** — every stream runs in a restart loop with
  exponential backoff (1s → 60s); SIGTERM drains cleanly (tini + entrypoint).
* **Idempotent writes** — hypertable PKs + `ON CONFLICT DO UPDATE/NOTHING`, and
  a Redis `SETNX` dedup guard in front of transformer inference.
* **Rate-limit resilience** — `retry_with_backoff` honours platform
  `Retry-After` headers with full jitter.
* **WS gateway hygiene** — per-client PubSub with guaranteed unsubscribe on
  disconnect, keep-alive pings, bounded queues, symbol allowlist (close 4404).
* **Frontend resilience** — `ReconnectingWebSocket` (full-jitter backoff,
  heartbeat), zero-CLS fixed-height skeletons, stale-frame rejection.

## 6. Security

* Explicit CORS origin allowlist (no wildcards).
* Security headers on every response (nosniff, DENY, HSTS, referrer policy).
* Redis-backed distributed rate limiting shared across Uvicorn workers.
* Secrets only via environment (`.env.example` documents every variable).
* No credential ever crosses an API response; social SDK clients live only
  inside the ingestion process.

## 7. Scaling notes

* The API gateway is stateless — scale `backend-api` horizontally behind any
  TCP/WS load balancer; Redis pub/sub fans out frames to every instance.
* One analytics worker per shard of symbols (compose `SYMBOLS` env) keeps
  transformer inference saturated without contention.
* TimescaleDB chunk intervals (7d hot tables) align with the 180-day retention;
  compressed chunks keep storage bounded.

Historical design documents from the previous client-side implementation are
preserved under [docs/legacy/](legacy/).
