"use client";

/**
 * SentimentDivergenceAlert – highlights technical divergences between price
 * action and social sentiment: price lower-low vs sentiment higher-low
 * (bullish) and price higher-high vs sentiment lower-high (bearish).
 */

import { timeAgo } from "@/lib/format";
import { useTerminalStore } from "@/store/terminalStore";
import { SkeletonCard } from "@/components/Skeleton";
import type { DivergenceSignal } from "@/types";

export function SentimentDivergenceAlert() {
  const divergences = useTerminalStore((s) => s.divergences);
  const liveDivergence = useTerminalStore(
    (s) => s.confluence?.sentiment_detail.divergence ?? null,
  );
  const loading = useTerminalStore((s) => s.historyLoading);

  // The live WS signal may carry a fresher detection than the 60s REST poll.
  const signals: DivergenceSignal[] = liveDivergence
    ? [liveDivergence, ...divergences.filter((d) => d.detected_at !== liveDivergence.detected_at)]
    : divergences;

  if (loading && signals.length === 0) {
    return <SkeletonCard title="Divergence Radar" rows={3} className="min-h-[180px]" />;
  }

  return (
    <section className="rounded-lg border border-edge bg-panel p-4">
      <header className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Sentiment ⇄ Price Divergence
        </h3>
        <span className="text-[10px] text-slate-600">72h window</span>
      </header>

      {signals.length === 0 ? (
        <div className="mt-4 flex items-center gap-2 rounded border border-edge bg-canvas px-3 py-3 text-xs text-slate-500">
          <span className="inline-block h-2 w-2 rounded-full bg-slate-600" />
          No active divergence — price action and social trend are aligned.
        </div>
      ) : (
        <ul className="mt-3 space-y-2" data-testid="divergence-list">
          {signals.slice(0, 3).map((signal, index) => {
            const bullish = signal.kind === "bullish";
            const color = bullish ? "#26a69a" : "#ef5350";
            return (
              <li
                key={`${signal.detected_at}-${index}`}
                className="rounded border bg-canvas p-3"
                style={{ borderColor: `${color}55` }}
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-bold" style={{ color }}>
                    <span aria-hidden>{bullish ? "▲" : "▼"}</span>
                    {bullish ? "BULLISH DIVERGENCE" : "BEARISH DIVERGENCE"}
                  </span>
                  <span className="text-[10px] text-slate-600">
                    {timeAgo(signal.detected_at)}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                  {bullish
                    ? "Price printed a lower low while crowd sentiment printed a higher low — capitulation is decaying faster than price."
                    : "Price printed a higher high while crowd sentiment printed a lower high — distribution footprint."}
                </p>
                <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px]">
                  <Stat label="PRICE" value={`${signal.price_from.toFixed(0)} → ${signal.price_to.toFixed(0)}`} />
                  <Stat
                    label="SENTIMENT"
                    value={`${signal.sentiment_from.toFixed(2)} → ${signal.sentiment_to.toFixed(2)}`}
                  />
                  <Stat label="STRENGTH" value={`${(signal.strength * 100).toFixed(0)}%`} />
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded bg-edge">
                  <div
                    className="h-full transition-all duration-700"
                    style={{ width: `${signal.strength * 100}%`, backgroundColor: color }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-panel px-2 py-1">
      <div className="text-[9px] tracking-wider text-slate-600">{label}</div>
      <div className="text-slate-300">{value}</div>
    </div>
  );
}
