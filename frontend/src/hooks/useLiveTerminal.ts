"use client";

/**
 * Terminal bootstrap hook.
 *
 * Owns the full data lifecycle for the currently selected symbol:
 *   1. REST hydration – watchlist, historical candles, divergence signals,
 *      composite score.
 *   2. Live streaming – multiplexed WebSocket (price/signal/sentiment/
 *      derivatives frames) with automatic reconnection.
 *   3. Slow refresh – divergence signals re-polled every 60s (they are
 *      computed over hourly buckets, so a slow cadence is plenty).
 */

import { useCallback, useEffect, useRef } from "react";

import { api } from "@/lib/api";
import { ReconnectingWebSocket, liveStreamUrl } from "@/lib/ws";
import {
  markFrameReceived,
  useTerminalStore,
} from "@/store/terminalStore";
import type {
  ConfluenceScore,
  DerivativeSnapshot,
  LiveCandle,
  PriceTick,
  SocialRecord,
  WSFrame,
} from "@/types";

export function useLiveTerminal(): void {
  const symbol = useTerminalStore((s) => s.symbol);
  const resolution = useTerminalStore((s) => s.resolution);
  const socketRef = useRef<ReconnectingWebSocket | null>(null);

  // ------------------------------------------------------------ REST hydration
  useEffect(() => {
    const controller = new AbortController();
    const store = useTerminalStore.getState();

    api
      .fetchOHLCV(symbol, resolution, 500, controller.signal)
      .then((payload) => useTerminalStore.getState().setHistory(payload.candles, false))
      .catch((error) => {
        if (controller.signal.aborted) return;
        useTerminalStore
          .getState()
          .setHistory([], false, error instanceof Error ? error.message : "history unavailable");
      });

    api
      .fetchCompositeScore(symbol, controller.signal)
      .then((score) => useTerminalStore.getState().applyConfluence(score))
      .catch(() => undefined); // gauge shows its own skeleton

    api
      .fetchWatchlist(controller.signal)
      .then((payload) =>
        useTerminalStore
          .getState()
          .setWatchlist(payload.symbols.map((entry) => entry.symbol)),
      )
      .catch(() => undefined);

    return () => controller.abort();
  }, [symbol, resolution]);

  // ---------------------------------------------------------- slow refresh
  useEffect(() => {
    const load = () => {
      api
        .fetchDivergences(symbol)
        .then((payload) => useTerminalStore.getState().applyDivergences(payload.signals))
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [symbol]);

  // ------------------------------------------------------- WebSocket stream
  useEffect(() => {
    const socket = new ReconnectingWebSocket({
      url: liveStreamUrl(symbol),
      onStateChange: (state) => useTerminalStore.getState().setConnection(state),
      onFrame: handleFrame,
    });
    socketRef.current = socket;
    socket.connect();
    return () => {
      socket.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const closeSocket = useCallback(() => socketRef.current?.close(), []);
  useEffect(() => {
    window.addEventListener("beforeunload", closeSocket);
    return () => window.removeEventListener("beforeunload", closeSocket);
  }, [closeSocket]);
}

function handleFrame(frame: WSFrame): void {
  const store = useTerminalStore.getState();
  markFrameReceived();
  if (frame.channel === "price" && frame.type === "candle") {
    store.applyCandle(frame.data as unknown as LiveCandle);
  } else if (frame.channel === "price" && frame.type === "tick") {
    store.applyTick(frame.data as unknown as PriceTick);
  } else if (frame.channel === "signal" && frame.type === "confluence") {
    store.applyConfluence(frame.data as unknown as ConfluenceScore);
  } else if (frame.channel === "derivatives") {
    store.applyDerivatives(frame.data as unknown as DerivativeSnapshot);
  } else if (frame.channel === "sentiment") {
    store.applySocialRecord(
      frame.data as unknown as SocialRecord,
      frame.type === "alert",
    );
  }
}
