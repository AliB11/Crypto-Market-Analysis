# Crypto Intelligence Terminal

<div dir="rtl">

**ترمینال هوشمند تحلیل بازار رمزارز** — بازطراحی کامل و سازمانی پروژه‌ی قبلی (اپ استاتیک سمت کلاینت) به یک پلتفرم **بلادرنگ تحلیل تکنیکال، سنتیمنت اجتماعی و مشتقات** با معماری میکروسرویس، مدل زبانی ترنسفورمر، پایگاه‌داده سری‌زمانی TimescaleDB و ترمینال ویژوال حرفه‌ای.

</div>

A production-grade, real-time **Cryptocurrency Technical, Sentiment & Derivative Intelligence Terminal**. The original fragile client-side scraper has been completely redesigned into a decoupled microservices platform:

| Capability | Implementation |
|---|---|
| **Ingestion** | ccxt.pro WebSocket klines + ticker streams, Twitter API v2 (official `tweepy` SDK), Reddit (official `praw` SDK) — all async, with exponential backoff on 429s |
| **Storage** | PostgreSQL 15 + **TimescaleDB hypertables** (`market_ohlcv`, `social_sentiment`, `derivative_metrics`, `signal_snapshots`) with composite `(symbol, timestamp DESC)` indices and retention policies |
| **Real-time bus** | Redis 7 pub/sub channels (`ticks:*`, `signals:*`, `derivatives:*`, `sentiment_stream`) with AOF persistence |
| **NLP** | Contextual transformer inference — `cardiffnlp/twitter-roberta-base-sentiment-latest` with automatic `ProsusAI/finbert` fallback, batched, bot-filtered, reach-weighted |
| **Quant engine** | Log returns, annualised 30-day volatility, Wilder RSI(14), MACD(12,26,9), automated bullish/bearish divergence detection and a bounded **multi-factor confluence score ∈ [-100, +100]** (technical 35% / sentiment velocity 35% / derivatives 30%) |
| **API gateway** | FastAPI: CORS allowlist, security headers, Redis-backed rate limiting (slowapi), request tracing, `/api/v1/*` REST + multiplexed `WS /ws/live/{symbol}` |
| **Terminal UI** | Next.js 14 (App Router, TypeScript), TradingView Lightweight Charts (candles + volume + sentiment ribbon), Zustand, Tailwind dark-slate institutional theme, zero-CLS skeletons, resilient reconnecting banners |

---

## Architecture

```
                        ┌─────────────────────────────────────────────┐
                        │              analytics-worker                │
  Binance WS ──ccxt.pro──▶ market_feed.py ──┐   celery (asyncio pool)  │
  Twitter v2 / Reddit ────▶ social_ingestion┤──▶ tasks.py: confluence │
                        │                  │   refresh + retention    │
                        └──────────────────┼──────────────────────────┘
                                 Redis     │ pub/sub        │
                            (ticks/signals/sentiment/deriv)
                                           ▼                ▼
                        ┌──────────────────────────┐  ┌────────────────┐
                        │  backend-api (FastAPI)   │  │  timescaledb   │
                        │  REST /api/v1 + WS relay │◀─│  hypertables   │
                        └────────────┬─────────────┘  └────────────────┘
                                     │ REST + WS
                                     ▼
                        ┌──────────────────────────┐
                        │  frontend (Next.js 14)   │
                        │  Lightweight Charts UI   │
                        └──────────────────────────┘
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full data-flow, channel contracts and database schema.

## Quick start (Docker)

```bash
cp .env.example .env          # fill in optional Twitter/Reddit credentials
docker compose --env-file .env up --build
```

| Service | URL |
|---|---|
| Terminal UI | http://localhost:3000 |
| API gateway | http://localhost:8000 (`/docs` for OpenAPI) |
| Health probes | `GET /healthz`, `GET /readyz` |

Everything works with **zero credentials**: the market feed ingests from Binance public streams, and social ingestion degrades gracefully (logged warning) when Twitter/Reddit keys are absent.

## Repository layout

```
├── docker-compose.yml           # timescaledb, redis, backend-api, analytics-worker, frontend
├── .env.example                 # every tunable, documented
├── backend/
│   ├── main.py                  # FastAPI gateway: middleware, REST, WS, lifespan
│   ├── config.py                # typed pydantic-settings (12-factor)
│   ├── db.py / cache.py         # asyncpg pool + Redis bus
│   ├── schemas.py               # Pydantic wire contracts
│   ├── repositories.py          # SQL layer (time_bucket, upserts, drop_chunks)
│   ├── services/
│   │   ├── quantitative.py      # quant & confluence engine (pure, fully documented)
│   │   ├── nlp.py               # transformer inference engine (lazy-loaded)
│   │   └── text_processing.py   # sanitation, bot heuristics, author weighting
│   ├── workers/
│   │   ├── market_feed.py       # ccxt.pro WS ingestion + derivative polling
│   │   ├── social_ingestion.py  # Twitter v2 + Reddit collectors → NLP → DB/Redis
│   │   ├── celery_app.py        # beat schedule (60s confluence, retention)
│   │   └── tasks.py             # async Celery tasks
│   ├── database/
│   │   ├── init.sql             # hypertables, indices, retention (idempotent)
│   │   └── migrate.py           # minimal migration runner
│   ├── entrypoint.sh            # wait-for-db → migrations → redis check → spawn
│   ├── tests/                   # test_quant / test_nlp / test_api (90 tests)
│   └── Dockerfile               # api | worker build profiles
├── frontend/
│   ├── src/components/          # ChartContainer, ConfluenceGauge, SentimentDivergenceAlert,
│   │                            # OrderFlowSummary, SocialFeed, ConnectionBanner, …
│   ├── src/store/               # Zustand terminal store
│   ├── src/lib/                 # api client, reconnecting WebSocket, formatters
│   └── src/hooks/               # useLiveTerminal (REST hydration + WS streaming)
├── scripts/demo_api.py          # full-stack demo/preview without infrastructure
└── docs/                        # architecture + legacy research notes
```

## The confluence model

```
S = 100 · tanh(1.4 · (0.35·T + 0.35·E + 0.30·D)) · liquidity_shrink

T (technical)    = ½·clip((RSI−50)/25) + ½·tanh(MACD_hist% / 20bps)
E (sentiment)    = 0.55·weighted_polarity + 0.45·(0.6·velocity + 0.4·divergence_bias)
D (derivatives)  = 0.6·(−tanh(funding_deviation)) + 0.4·sign(momentum)·tanh(|ΔOI%|/10)
```

* author weight `W = log(1 + engagement + followers)` compresses whale reach,
* divergence = price lower-low vs sentiment higher-low (bullish) and inverse (bearish),
* low-liquidity symbols are shrunk toward zero with an explicit `low_liquidity` warning,
* every edge case (NaN, flat series, zero division, missing data) degrades to neutral with warnings instead of crashing.

## Running the test suite

```bash
cd backend
pip install -r requirements.txt
pytest                  # 90 tests: quant, NLP, API (no services required)
```

## Local development (without Docker)

```bash
# terminal 1 – API
cd backend && uvicorn main:app --reload

# terminal 2 – demo data fabric (synthetic market + social streams)
python scripts/demo_api.py --port 8000      # or run real workers with credentials

# terminal 3 – frontend
cd frontend && npm install && npm run dev
```

## API surface

| Endpoint | Description |
|---|---|
| `GET /api/v1/market/symbols` | monitored watchlist |
| `GET /api/v1/market/ohlcv/{symbol}?resolution=5m\|1h\|1d` | history with dynamic TimescaleDB bucketing |
| `GET /api/v1/sentiment/divergence/{symbol}` | bullish/bearish price↔sentiment divergences |
| `GET /api/v1/analytics/composite-score/{symbol}` | confluence score + full breakdown |
| `WS /ws/live/{symbol}` | multiplexed price ticks, signals, social alerts, derivatives |

---

<div dir="rtl">

⚠️ **سلب مسئولیت:** این پلتفرم صرفاً برای تحلیل و پژوهش ساخته شده و توصیه‌ی مالی نیست.

</div>

*Not financial advice — research and analytics tooling only.*
