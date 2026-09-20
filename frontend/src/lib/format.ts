/** Numeric formatting helpers (institutional terminal conventions). */

export function formatPrice(value: number | null | undefined, digits?: number): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const d = digits ?? (value >= 1000 ? 2 : value >= 1 ? 3 : 6);
  return value.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

export function formatCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

/** Funding rate is quoted per 8h – show the annualised carry too. */
export function formatFunding(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${rate >= 0 ? "+" : ""}${(rate * 100).toFixed(4)}%`;
}

export function formatFundingApr(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${rate >= 0 ? "+" : ""}${(rate * 3 * 365 * 100).toFixed(1)}% APR`;
}

export function timeAgo(input: string | Date | number): string {
  const ts =
    typeof input === "number"
      ? input
      : typeof input === "string"
        ? new Date(input).getTime()
        : input.getTime();
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function polarityColor(polarity: number): string {
  if (polarity > 0.15) return "text-bull";
  if (polarity < -0.15) return "text-bear";
  return "text-slate-400";
}

export function scoreColor(score: number): string {
  if (score >= 20) return "#26a69a";
  if (score <= -20) return "#ef5350";
  return "#f59e0b";
}
