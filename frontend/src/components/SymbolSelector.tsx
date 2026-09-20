"use client";

/** Watchlist switcher with resolution toggle for the chart time-frame. */

import clsx from "clsx";

import { useTerminalStore } from "@/store/terminalStore";
import type { Resolution } from "@/types";

const RESOLUTIONS: Resolution[] = ["5m", "1h", "1d"];

export function SymbolSelector() {
  const watchlist = useTerminalStore((s) => s.watchlist);
  const symbol = useTerminalStore((s) => s.symbol);
  const resolution = useTerminalStore((s) => s.resolution);
  const setSymbol = useTerminalStore((s) => s.setSymbol);
  const setResolution = useTerminalStore((s) => s.setResolution);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {watchlist.map((entry) => (
        <button
          key={entry}
          type="button"
          onClick={() => setSymbol(entry)}
          aria-pressed={entry === symbol}
          className={clsx(
            "rounded px-2.5 py-1 font-mono text-xs font-semibold transition-colors",
            entry === symbol
              ? "bg-accent/20 text-accent ring-1 ring-accent/40"
              : "text-slate-400 hover:bg-edge hover:text-slate-200",
          )}
        >
          {entry}
        </button>
      ))}
      <span className="mx-1 h-4 w-px bg-edge" aria-hidden />
      {RESOLUTIONS.map((res) => (
        <button
          key={res}
          type="button"
          onClick={() => setResolution(res)}
          aria-pressed={res === resolution}
          className={clsx(
            "rounded px-2 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors",
            res === resolution
              ? "bg-slate-700 text-slate-100"
              : "text-slate-500 hover:bg-edge hover:text-slate-300",
          )}
        >
          {res}
        </button>
      ))}
    </div>
  );
}
