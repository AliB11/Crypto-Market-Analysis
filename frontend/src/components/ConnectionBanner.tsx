"use client";

/**
 * ConnectionBanner – resilient WebSocket status indicator.
 *
 * A compact status pill is always visible in the header; when the stream is
 * degraded (reconnecting/offline) a full-width banner explains the state and
 * the automatic recovery policy so operators never wonder about staleness.
 */

import { useTerminalStore } from "@/store/terminalStore";

const STATE_META = {
  connecting: { label: "CONNECTING", color: "text-accent", dot: "bg-accent", animate: true },
  live: { label: "LIVE", color: "text-bull", dot: "bg-bull", animate: true },
  reconnecting: { label: "RECONNECTING", color: "text-warn", dot: "bg-warn", animate: true },
  offline: { label: "OFFLINE", color: "text-bear", dot: "bg-bear", animate: false },
} as const;

export function ConnectionPill() {
  const connection = useTerminalStore((s) => s.connection);
  const meta = STATE_META[connection];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border border-edge bg-canvas px-2 py-1 text-[10px] font-bold tracking-wider ${meta.color}`}
      role="status"
      aria-label={`stream ${connection}`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${meta.dot} ${
          meta.animate ? "animate-pulse-dot" : ""
        }`}
      />
      {meta.label}
    </span>
  );
}

export function ConnectionBanner() {
  const connection = useTerminalStore((s) => s.connection);
  if (connection === "live") return null;

  const messages: Record<string, string> = {
    connecting: "Establishing real-time stream…",
    reconnecting: "Stream interrupted — reconnecting with exponential backoff. Showing last known state.",
    offline: "Stream offline. Data shown may be stale; the client will retry automatically.",
  };

  return (
    <div
      className={`flex items-center gap-2 rounded border px-3 py-2 text-xs ${
        connection === "connecting"
          ? "border-accent/40 bg-accent/10 text-accent"
          : connection === "reconnecting"
            ? "border-warn/40 bg-warn/10 text-warn"
            : "border-bear/40 bg-bear/10 text-bear"
      }`}
      role="alert"
    >
      <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-current opacity-80" />
      {messages[connection]}
    </div>
  );
}
