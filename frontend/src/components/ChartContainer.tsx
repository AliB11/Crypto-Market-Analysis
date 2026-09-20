"use client";

/**
 * ChartContainer – TradingView Lightweight Charts embedding.
 *
 *  - Candlestick series fed by REST history then live WS candle updates.
 *  - Synchronised volume histogram (institutional palette: #26a69a bullish,
 *    #ef5350 bearish) rendered on the bottom 20% of the price pane.
 *  - Sentiment ribbon under the time axis: an overlay histogram series on
 *    its own price scale (bottom ~12%) painting hourly social polarity
 *    regime shifts in the same bull/bear palette.
 *  - Crosshair OHLC readout, fixed layout => zero cumulative layout shift.
 */

import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
  createChart,
} from "lightweight-charts";

import { formatCompact, formatPrice } from "@/lib/format";
import { useTerminalStore } from "@/store/terminalStore";
import type { Candle } from "@/types";

const COLORS = {
  background: "#0f172a",
  text: "#94a3b8",
  grid: "#1e293b",
  bull: "#26a69a",
  bear: "#ef5350",
  bullDim: "rgba(38, 166, 154, 0.45)",
  bearDim: "rgba(239, 83, 80, 0.45)",
};

interface HoverState {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  change: number;
}

export function ChartContainer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ribbonSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const [hover, setHover] = useState<HoverState | null>(null);

  const symbol = useTerminalStore((s) => s.symbol);
  const resolution = useTerminalStore((s) => s.resolution);
  const candles = useTerminalStore((s) => s.candles);
  const ribbon = useTerminalStore((s) => s.sentimentRibbon);
  const historyLoading = useTerminalStore((s) => s.historyLoading);
  const historyError = useTerminalStore((s) => s.historyError);

  // ------------------------------------------------------ chart construction
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: COLORS.background },
        textColor: COLORS.text,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#475569", labelBackgroundColor: "#1e293b" },
        horzLine: { color: "#475569", labelBackgroundColor: "#1e293b" },
      },
      rightPriceScale: { borderColor: COLORS.grid, scaleMargins: { top: 0.08, bottom: 0.28 } },
      timeScale: {
        borderColor: COLORS.grid,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      // Explicit locale: never derive from navigator.language, which can be
      // an invalid BCP-47 tag on some webviews/embedded browsers.
      localization: { locale: "en-US" },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      autoSize: true,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: COLORS.bull,
      downColor: COLORS.bear,
      wickUpColor: COLORS.bull,
      wickDownColor: COLORS.bear,
      borderVisible: false,
      priceLineColor: "#64748b",
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    // Sentiment ribbon occupies the sliver just under the time axis.
    const ribbonSeries = chart.addHistogramSeries({
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      priceScaleId: "sentiment",
      base: 0,
    });
    chart.priceScale("sentiment").applyOptions({
      scaleMargins: { top: 0.9, bottom: 0.005 },
      visible: false,
    });

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData.size) {
        setHover(null);
        return;
      }
      const candle = param.seriesData.get(candleSeries);
      const volume = param.seriesData.get(volumeSeries);
      if (!candle) {
        setHover(null);
        return;
      }
      const c = candle as unknown as Candle;
      const v = volume ? (volume as unknown as { value: number }).value : 0;
      setHover({
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        v,
        change: ((c.close - c.open) / c.open) * 100,
      });
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    ribbonSeriesRef.current = ribbonSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      ribbonSeriesRef.current = null;
    };
  }, []);

  // --------------------------------------------------- history (re)hydration
  useEffect(() => {
    const series = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!series || !volumeSeries || !chart) return;

    series.setData(
      candles.map((candle) => ({
        time: candle.time as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    );
    volumeSeries.setData(
      candles.map((candle) => ({
        time: candle.time as UTCTimestamp,
        value: candle.volume,
        color: candle.close >= candle.open ? COLORS.bullDim : COLORS.bearDim,
      })),
    );
    if (candles.length) {
      chart.timeScale().fitContent();
    }
  }, [candles]);

  // ------------------------------------------------------- sentiment ribbon
  useEffect(() => {
    const series = ribbonSeriesRef.current;
    if (!series || ribbon.length === 0) return;
    series.setData(
      ribbon.map((point) => ({
        time: point.time as UTCTimestamp,
        value: point.value,
        color: point.value >= 0 ? COLORS.bull : COLORS.bear,
      })),
    );
  }, [ribbon]);

  const lastCandle = candles[candles.length - 1];
  const readout = hover ?? (lastCandle
    ? {
        o: lastCandle.open,
        h: lastCandle.high,
        l: lastCandle.low,
        c: lastCandle.close,
        v: lastCandle.volume,
        change: ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100,
      }
    : null);

  return (
    <section className="flex h-full flex-col rounded-lg border border-edge bg-panel">
      <header className="flex items-center justify-between border-b border-edge px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-semibold text-slate-100">
            {symbol}
            <span className="text-slate-500">/USDT</span>
          </h2>
          <span className="text-xs uppercase tracking-wider text-slate-500">
            {resolution} · TradingView
          </span>
        </div>
        {readout && (
          <div className="flex items-center gap-3 font-mono text-[11px] text-slate-400">
            <span>
              O <span className="text-slate-200">{formatPrice(readout.o)}</span>
            </span>
            <span>
              H <span className="text-slate-200">{formatPrice(readout.h)}</span>
            </span>
            <span>
              L <span className="text-slate-200">{formatPrice(readout.l)}</span>
            </span>
            <span>
              C{" "}
              <span className={readout.change >= 0 ? "text-bull" : "text-bear"}>
                {formatPrice(readout.c)}
              </span>
            </span>
            <span>
              V <span className="text-slate-200">{formatCompact(readout.v)}</span>
            </span>
          </div>
        )}
      </header>

      <div className="relative min-h-[380px] flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {historyLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-panel/60 backdrop-blur-[1px]">
            <ChartSkeleton />
          </div>
        )}
        {historyError && !historyLoading && (
          <div className="absolute inset-x-0 top-2 z-10 mx-auto w-fit rounded border border-bear/40 bg-bear/10 px-3 py-1.5 text-xs text-bear">
            {historyError} — retrying on reconnect
          </div>
        )}
        <div className="pointer-events-none absolute bottom-1 left-3 z-10 flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-600">
          <span className="inline-block h-2 w-2 rounded-sm bg-bull" /> sentiment ribbon
          <span className="inline-block h-2 w-2 rounded-sm bg-bear" />
        </div>
      </div>
    </section>
  );
}

function ChartSkeleton() {
  return (
    <div className="flex w-64 flex-col gap-2">
      {[0.55, 0.9, 0.4, 0.75, 0.6].map((width, index) => (
        <div
          key={index}
          className="skeleton h-3 rounded"
          style={{ width: `${width * 100}%` }}
        />
      ))}
    </div>
  );
}
