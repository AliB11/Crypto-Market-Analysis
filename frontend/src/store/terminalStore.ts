/**
 * Global terminal state (Zustand).
 *
 * One store, four cohesive slices: market, analytics, social and connection.
 * The WS hook and REST fetchers are the only writers; components are pure
 * readers.  Buffers are bounded so a long session cannot leak memory.
 */

import { create } from "zustand";

import type {
  Candle,
  ConfluenceScore,
  ConnectionState,
  DerivativeSnapshot,
  DivergenceSignal,
  LiveCandle,
  PriceTick,
  Resolution,
  SocialRecord,
} from "@/types";

const MAX_CANDLES = 2000;
const MAX_ALERTS = 40;
const MAX_RIBBON = 400;

export interface SocialAlert extends SocialRecord {
  receivedAt: number;
}

export interface OrderFlowState {
  fundingRate: number | null;
  openInterest: number | null;
  longShortRatio: number | null;
  updatedAt: string | null;
}

interface TerminalState {
  // ---------------------------------------------------------------- market
  symbol: string;
  resolution: Resolution;
  candles: Candle[];
  lastCandle: Candle | null;
  lastTick: PriceTick | null;
  watchlist: string[];
  historyLoading: boolean;
  historyError: string | null;

  // ------------------------------------------------------------ analytics
  confluence: ConfluenceScore | null;
  divergences: DivergenceSignal[];
  orderFlow: OrderFlowState;
  sentimentRibbon: { time: number; value: number }[];

  // ---------------------------------------------------------------- social
  alerts: SocialAlert[];

  // ------------------------------------------------------------- connection
  connection: ConnectionState;
  lastFrameAt: number | null;

  // -------------------------------------------------------------- actions
  setSymbol: (symbol: string) => void;
  setResolution: (resolution: Resolution) => void;
  setWatchlist: (symbols: string[]) => void;
  setHistory: (candles: Candle[], loading: boolean, error?: string | null) => void;
  applyCandle: (candle: LiveCandle) => void;
  applyTick: (tick: PriceTick) => void;
  applyConfluence: (score: ConfluenceScore) => void;
  applyDivergences: (signals: DivergenceSignal[]) => void;
  applyDerivatives: (snapshot: DerivativeSnapshot) => void;
  applySocialRecord: (record: SocialRecord, isAlert: boolean) => void;
  setConnection: (state: ConnectionState) => void;
  resetForSymbol: (symbol: string) => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  symbol: "BTC",
  resolution: "5m",
  candles: [],
  lastCandle: null,
  lastTick: null,
  watchlist: ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA"],
  historyLoading: true,
  historyError: null,

  confluence: null,
  divergences: [],
  orderFlow: {
    fundingRate: null,
    openInterest: null,
    longShortRatio: null,
    updatedAt: null,
  },
  sentimentRibbon: [],

  alerts: [],

  connection: "connecting",
  lastFrameAt: null,

  setSymbol: (symbol) =>
    set((state) => {
      if (state.symbol === symbol) return state;
      return {
        symbol,
        candles: [],
        lastCandle: null,
        lastTick: null,
        confluence: null,
        divergences: [],
        sentimentRibbon: [],
        alerts: [],
        historyLoading: true,
        historyError: null,
        orderFlow: { fundingRate: null, openInterest: null, longShortRatio: null, updatedAt: null },
      };
    }),

  setResolution: (resolution) =>
    set((state) => ({
      resolution,
      historyLoading: state.resolution !== resolution,
      candles: [],
      lastCandle: null,
    })),

  setWatchlist: (symbols) => set({ watchlist: symbols }),

  setHistory: (candles, loading, error = null) =>
    set({
      candles: candles.slice(-MAX_CANDLES),
      lastCandle: candles.length ? candles[candles.length - 1] : null,
      historyLoading: loading,
      historyError: error,
    }),

  applyCandle: (live) =>
    set((state) => {
      const candle: Candle = {
        time: live.time,
        open: live.open,
        high: live.high,
        low: live.low,
        close: live.close,
        volume: live.volume,
      };
      const candles = [...state.candles];
      const last = candles[candles.length - 1];
      if (last && last.time === candle.time) {
        candles[candles.length - 1] = candle;
      } else if (!last || candle.time > last.time) {
        candles.push(candle);
        if (candles.length > MAX_CANDLES) candles.shift();
      } else {
        return state; // stale out-of-order frame
      }
      return {
        candles,
        lastCandle: candle,
        historyLoading: false,
        lastTick: {
          symbol: live.symbol,
          pair: live.pair,
          price: live.close,
          change_pct: state.lastTick?.change_pct ?? null,
          quote_volume: state.lastTick?.quote_volume ?? null,
        },
      };
    }),

  applyTick: (tick) => set({ lastTick: tick }),

  applyConfluence: (confluence) => set({ confluence }),

  applyDivergences: (divergences) => set({ divergences }),

  applyDerivatives: (snapshot) =>
    set(() => ({
      orderFlow: {
        fundingRate: snapshot.funding_rate,
        openInterest: snapshot.open_interest,
        longShortRatio: snapshot.long_short_ratio,
        updatedAt: snapshot.as_of,
      },
    })),

  applySocialRecord: (record, isAlert) =>
    set((state) => {
      // Ribbon bucket: hourly aggregate of raw polarity (chart overlay).
      const bucket = Math.floor(new Date(record.timestamp).getTime() / 3600_000) * 3600;
      const ribbon = [...state.sentimentRibbon];
      const lastPoint = ribbon[ribbon.length - 1];
      if (lastPoint && lastPoint.time === bucket) {
        ribbon[ribbon.length - 1] = {
          time: bucket,
          value: lastPoint.value * 0.7 + record.polarity * 0.3, // EMA smoothing
        };
      } else if (!lastPoint || bucket > lastPoint.time) {
        ribbon.push({ time: bucket, value: record.polarity });
        if (ribbon.length > MAX_RIBBON) ribbon.shift();
      }
      if (!isAlert) return { sentimentRibbon: ribbon };
      const alerts = [
        { ...record, receivedAt: Date.now() },
        ...state.alerts.filter((a) => a.text !== record.text),
      ].slice(0, MAX_ALERTS);
      return { sentimentRibbon: ribbon, alerts };
    }),

  setConnection: (connection) => set({ connection }),

  resetForSymbol: () => set({ connection: "connecting", lastFrameAt: Date.now() }),
}));

/** Mark inbound frames so the UI can show a "streaming" liveness dot. */
export function markFrameReceived(): void {
  useTerminalStore.setState({ lastFrameAt: Date.now() });
}
