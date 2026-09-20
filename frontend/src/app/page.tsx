"use client";

/**
 * Terminal page – high-density professional layout:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ header: brand · symbol/resolution switch · price · status    │
 *   ├──────────────────────────────────────────────┬───────────────┤
 *   │                                              │ ConfluenceGauge│
 *   │            ChartContainer                    ├───────────────┤
 *   │   (candles + volume + sentiment ribbon)      │ OrderFlow     │
 *   │                                              ├───────────────┤
 *   ├──────────────────────────────────────────────┤ Divergence    │
 *   │ SocialFeed (high-impact alerts)              │ radar         │
 *   └──────────────────────────────────────────────┴───────────────┘
 *
 * All panels ship with fixed-height skeletons => zero CLS.
 */

import { ChartContainer } from "@/components/ChartContainer";
import { ConnectionBanner, ConnectionPill } from "@/components/ConnectionBanner";
import { ConfluenceGauge } from "@/components/ConfluenceGauge";
import { OrderFlowSummary } from "@/components/OrderFlowSummary";
import { SentimentDivergenceAlert } from "@/components/SentimentDivergenceAlert";
import { SocialFeed } from "@/components/SocialFeed";
import { SymbolSelector } from "@/components/SymbolSelector";
import { useLiveTerminal } from "@/hooks/useLiveTerminal";
import { formatCompact, formatPercent, formatPrice } from "@/lib/format";
import { useTerminalStore } from "@/store/terminalStore";

export default function TerminalPage() {
  useLiveTerminal();

  const symbol = useTerminalStore((s) => s.symbol);
  const lastTick = useTerminalStore((s) => s.lastTick);
  const lastCandle = useTerminalStore((s) => s.lastCandle);
  const confluence = useTerminalStore((s) => s.confluence);

  const price = lastTick?.price ?? lastCandle?.close ?? null;
  const change = lastTick?.change_pct ?? null;
  const quoteVolume = lastTick?.quote_volume ?? null;

  return (
    <main className="mx-auto flex min-h-screen max-w-[1600px] flex-col gap-3 p-3 lg:p-4">
      {/* ---------------------------------------------------------- header */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-edge bg-panel px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded bg-gradient-to-br from-accent/80 to-blue-700 font-mono text-xs font-black text-white">
            λ
          </span>
          <div>
            <h1 className="text-sm font-bold leading-tight text-slate-100">
              Crypto Intelligence Terminal
            </h1>
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              technical · sentiment · derivatives
            </p>
          </div>
        </div>

        <div className="ml-2">
          <SymbolSelector />
        </div>

        <div className="ml-auto flex items-center gap-4">
          <div className="text-right">
            <div className="font-mono text-lg font-bold leading-tight text-slate-100">
              {formatPrice(price)}
              <span className="ml-1 text-[10px] text-slate-500">USDT</span>
            </div>
            <div className="flex items-center justify-end gap-2 font-mono text-[11px]">
              {change != null && (
                <span className={change >= 0 ? "text-bull" : "text-bear"}>
                  {formatPercent(change)}
                </span>
              )}
              {quoteVolume != null && (
                <span className="text-slate-500">vol {formatCompact(quoteVolume)}</span>
              )}
            </div>
          </div>
          <ConnectionPill />
        </div>
      </header>

      <ConnectionBanner />

      {/* ------------------------------------------------------ main grid */}
      <div className="grid flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-h-[560px] flex-col gap-3">
          <div className="min-h-[440px] flex-1">
            <ChartContainer />
          </div>
          <div className="min-h-[280px]">
            <SocialFeed />
          </div>
        </div>

        <aside className="flex flex-col gap-3">
          <ConfluenceGauge />
          <OrderFlowSummary />
          <SentimentDivergenceAlert />
        </aside>
      </div>

      <footer className="flex items-center justify-between px-1 pb-1 text-[10px] text-slate-600">
        <span>
          {symbol}/USDT · confluence{" "}
          {confluence ? `${confluence.score >= 0 ? "+" : ""}${confluence.score.toFixed(0)}` : "—"} ·
          multi-factor model 35/35/30
        </span>
        <span>
          Not financial advice. Data: exchange public streams + social APIs, TimescaleDB
          hypertables.
        </span>
      </footer>
    </main>
  );
}
