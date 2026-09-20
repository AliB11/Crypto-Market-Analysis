import type { Config } from "tailwindcss";

/**
 * Institutional dark-slate design system.
 * Base canvas: #020617 (slate-950) / panels #0f172a (slate-900).
 * Bullish: #26a69a, Bearish: #ef5350 (TradingView institutional palette).
 */
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#020617",
        panel: "#0f172a",
        edge: "#1e293b",
        bull: "#26a69a",
        bear: "#ef5350",
        accent: "#38bdf8",
        warn: "#f59e0b",
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        shimmer: "shimmer 1.4s linear infinite",
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
