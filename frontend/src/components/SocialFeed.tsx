"use client";

/**
 * SocialFeed – high-impact social alerts streamed over the sentiment
 * channel: transformer-classified posts that exceed the polarity/confidence
 * alert thresholds.
 */

import { polarityColor, timeAgo } from "@/lib/format";
import { useTerminalStore } from "@/store/terminalStore";

const PLATFORM_BADGE: Record<string, { label: string; className: string }> = {
  twitter: { label: "X", className: "bg-slate-700 text-slate-200" },
  reddit: { label: "r/", className: "bg-orange-900/60 text-orange-300" },
};

export function SocialFeed() {
  const alerts = useTerminalStore((s) => s.alerts);

  return (
    <section className="flex min-h-[280px] flex-col rounded-lg border border-edge bg-panel">
      <header className="flex items-center justify-between border-b border-edge px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          High-Impact Social Stream
        </h3>
        <span className="text-[10px] text-slate-600">|p| ≥ 0.45 · conf ≥ 0.65</span>
      </header>

      {alerts.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 py-8 text-center text-xs text-slate-600">
          Awaiting transformer-flagged alerts on the sentiment stream…
        </div>
      ) : (
        <ul className="max-h-[320px] divide-y divide-edge overflow-y-auto" data-testid="social-feed">
          {alerts.map((alert, index) => {
            const badge = PLATFORM_BADGE[alert.platform] ?? PLATFORM_BADGE.twitter;
            return (
              <li key={`${alert.timestamp}-${index}`} className="px-4 py-2.5">
                <div className="flex items-center gap-2 text-[10px] text-slate-500">
                  <span className={`rounded px-1.5 py-0.5 font-bold ${badge.className}`}>
                    {badge.label}
                  </span>
                  <span className="font-medium text-slate-400">@{alert.author}</span>
                  <span>· {alert.author_reach.toLocaleString()} reach</span>
                  <span className="ml-auto">{timeAgo(alert.receivedAt)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-300">
                  {alert.text}
                </p>
                <div className="mt-1 flex items-center gap-2 font-mono text-[10px]">
                  <span className={polarityColor(alert.polarity)}>
                    {alert.polarity >= 0 ? "▲" : "▼"} {alert.polarity.toFixed(2)}
                  </span>
                  <span className="text-slate-600">
                    conf {(alert.confidence * 100).toFixed(0)}% · w {alert.weight.toFixed(1)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
