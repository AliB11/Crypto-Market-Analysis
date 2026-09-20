/**
 * Wire-format types shared with backend/backend/schemas.py.
 * Keep in sync with the Pydantic contracts – this file is the TypeScript
 * mirror of the API's response models.
 */

export type Resolution = "5m" | "1h" | "1d";
export type Regime = "risk_on" | "neutral" | "risk_off";
export type DivergenceKind = "bullish" | "bearish";
export type Platform = "twitter" | "reddit";

export interface Candle {
  time: number; // UNIX seconds (bucket open)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OHLCVResponse {
  symbol: string;
  resolution: Resolution;
  candles: Candle[];
  count: number;
}

export interface SymbolInfo {
  symbol: string;
  ccxt_symbol: string;
}

export interface WatchlistResponse {
  quote: string;
  symbols: SymbolInfo[];
}

export interface DivergenceSignal {
  kind: DivergenceKind;
  detected_at: string;
  price_pivot_time: string;
  price_from: number;
  price_to: number;
  sentiment_from: number;
  sentiment_to: number;
  strength: number; // [0, 1]
}

export interface DivergenceResponse {
  symbol: string;
  window_hours: number;
  signals: DivergenceSignal[];
}

export interface TechnicalDetail {
  rsi: number | null;
  macd_line: number | null;
  macd_signal: number | null;
  macd_histogram: number | null;
  historical_volatility_30d: number | null;
  last_close: number | null;
}

export interface SentimentDetail {
  weighted_polarity: number | null;
  velocity: number | null;
  divergence: DivergenceSignal | null;
  sample_size: number;
}

export interface DerivativeDetail {
  funding_rate: number | null;
  funding_deviation: number | null;
  open_interest: number | null;
  open_interest_delta_24h_pct: number | null;
  long_short_ratio: number | null;
}

export interface ConfluenceScore {
  symbol: string;
  score: number; // [-100, 100]
  regime: Regime;
  confidence: number; // [0, 1]
  technical: number; // [-1, 1]
  sentiment: number;
  derivative: number;
  technical_detail: TechnicalDetail;
  sentiment_detail: SentimentDetail;
  derivative_detail: DerivativeDetail;
  warnings: string[];
  computed_at: string;
}

// ---------------------------------------------------------------- WebSocket
export type WSChannel = "price" | "signal" | "sentiment" | "derivatives" | "status";

export interface WSFrame<T = Record<string, unknown>> {
  channel: WSChannel;
  type: string;
  symbol: string;
  data: T;
  server_ts: string;
}

export interface PriceTick {
  symbol: string;
  pair: string;
  price: number;
  bid?: number | null;
  ask?: number | null;
  change_pct?: number | null;
  quote_volume?: number | null;
}

export interface LiveCandle {
  symbol: string;
  pair: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DerivativeSnapshot {
  funding_rate: number | null;
  open_interest: number | null;
  long_short_ratio: number | null;
  as_of: string;
}

export interface SocialRecord {
  platform: Platform;
  symbol: string;
  author: string;
  author_reach: number;
  engagement: number;
  text: string;
  polarity: number;
  confidence: number;
  label: string;
  weight: number;
  timestamp: string;
}

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";
