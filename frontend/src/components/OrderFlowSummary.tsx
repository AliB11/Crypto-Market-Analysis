"use client";

/**
 * OrderFlowSummary – real-time derivatives panel: perpetual funding rate
 * (with annualised carry), 24h open-interest shift and the global long/short
 * account ratio, distilled into a liquidation-bias verdict.
 */

import { formatCompact, formatFunding, formatFundingApr, formatPercent } from "@/lib/format";
import { useTerminalStore } from "@/store/terminalStore";
import { SkeletonCard } from "@/components/Skeleton";

export function OrderFlowSummary() {
  const orderFlow = useTerminalStore((s) => s.orderFlow);
  const lastTick = useTerminalStore((s) => s.lastTick);
  const confluence = useTerminalStore((s) => s.confluence);
  const oiDelta = confluence?.derivative_detail.open_interest_delta_24h_pct ?? null;

  const hasData =
    orderFlow.fundingRate != null || orderFlow.openInterest != null || oiDelta != null;

  if (!hasData) {
    return <SkeletonCard title="Order Flow & Derivatives" rows={4} className="min-h-[196px]" />;
  }

  const funding = orderFlow.fundingRate;
  const lsr = orderFlow.longShortRatio;
  const bias = liquidationBias(funding, lsr, oiDelta);

  return (
    <section className="rounded-lg border border-edge bg-panel p-4">
      <header className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Order Flow & Derivatives
        </h3>
        {lastTick?.change_pct != null && (
          <span
            className={`font-mono text-xs ${lastTick.change_pct >= 0 ? "text-bull" : "text-bear"}`}
          >
            {formatPercent(lastTick.change_pct)} 24h
          </span>
        )}
      </header>

      <dl className="mt-3 grid grid-cols-2 gap-2">
        <Metric
          label="Funding rate (8h)"
          value={formatFunding(funding)}
          sub={funding != null ? formatFundingApr(funding) : undefined}
          tone={funding == null ? "neutral" : funding > 0 ? "bear" : "bull"}
        />
        <Metric
          label="Open interest"
          value={formatCompact(orderFlow.openInterest)}
          sub={oiDelta != null ? `${formatPercent(oiDelta)} 24h` : undefined}
          tone={oiDelta == null ? "neutral" : oiDelta >= 0 ? "bull" : "bear"}
        />
        <Metric
          label="Long/short ratio"
          value={lsr != null ? lsr.toFixed(2) : "—"}
          sub={lsr == null ? undefined : lsr > 1 ? "longs crowded" : "shorts crowded"}
          tone={lsr == null ? "neutral" : lsr > 1.2 ? "bear" : lsr < 0.8 ? "bull" : "neutral"}
        />
        <Metric
          label="Liquidation bias"
          value={bias.label}
          tone={bias.tone}
          sub={bias.detail}
        />
      </dl>

      <p className="mt-3 rounded border border-edge bg-canvas px-2.5 py-2 text-[10px] leading-relaxed text-slate-500">
        Contrarian reading: rich positive funding = crowded longs (squeeze risk);
        deeply negative funding = short-squeeze fuel. OI expansion confirms
        trend direction.
      </p>
    </section>
  );
}

type Tone = "bull" | "bear" | "neutral";
const TONE_CLASS: Record<Tone, string> = {
  bull: "text-bull",
  bear: "text-bear",
  neutral: "text-slate-300",
};

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: Tone;
}) {
  return (
    <div className="rounded border border-edge bg-canvas px-2.5 py-2">
      <dt className="text-[9px] uppercase tracking-wider text-slate-600">{label}</dt>
      <dd className={`mt-0.5 font-mono text-sm font-semibold ${TONE_CLASS[tone]}`}>{value}</dd>
      {sub && <dd className="mt-0.5 text-[10px] text-slate-500">{sub}</dd>}
    </div>
  );
}

function liquidationBias(
  funding: number | null,
  lsr: number | null,
  oiDelta: number | null,
): { label: string; tone: Tone; detail?: string } {
  if (funding == null && lsr == null) {
    return { label: "—", tone: "neutral" };
  }
  const crowdedLongs = (funding != null && funding > 0.0003) || (lsr != null && lsr > 1.3);
  const crowdedShorts = (funding != null && funding < -0.0003) || (lsr != null && lsr < 0.7);
  if (crowdedLongs) {
    return {
      label: "Long squeeze",
      tone: "bear",
      detail: oiDelta != null && oiDelta > 0 ? "OI fuelled by longs" : undefined,
    };
  }
  if (crowdedShorts) {
    return { label: "Short squeeze", tone: "bull", detail: "shorts paying premium" };
  }
  return { label: "Balanced", tone: "neutral", detail: "no crowding detected" };
}
