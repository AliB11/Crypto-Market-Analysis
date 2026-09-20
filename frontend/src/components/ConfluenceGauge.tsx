"use client";

/**
 * ConfluenceGauge – semi-circular gauge rendering the composite confluence
 * score in [-100, +100] with an institutional red -> amber -> green gradient,
 * tick marks, needle and component breakdown bars.
 */

import { useTerminalStore } from "@/store/terminalStore";
import { SkeletonCard } from "@/components/Skeleton";

const SIZE = 220;
const CENTER_X = SIZE / 2;
const CENTER_Y = SIZE / 2 + 8;
const RADIUS = 86;

function polarToCartesian(angleDegrees: number, radius: number) {
  const rad = (angleDegrees * Math.PI) / 180;
  return { x: CENTER_X + radius * Math.cos(rad), y: CENTER_Y + radius * Math.sin(rad) };
}

/** Score [-100, 100] -> gauge angle [180 (left), 0 (right)]. */
function scoreToAngle(score: number): number {
  const clamped = Math.max(-100, Math.min(100, score));
  return 180 - ((clamped + 100) / 200) * 180;
}

function arcPath(startAngle: number, endAngle: number, radius: number): string {
  const start = polarToCartesian(startAngle, radius);
  const end = polarToCartesian(endAngle, radius);
  const largeArc = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

const REGIME_LABEL = {
  risk_on: { text: "RISK-ON", color: "#26a69a" },
  neutral: { text: "NEUTRAL", color: "#f59e0b" },
  risk_off: { text: "RISK-OFF", color: "#ef5350" },
} as const;

export function ConfluenceGauge() {
  const confluence = useTerminalStore((s) => s.confluence);

  if (!confluence) {
    return (
      <SkeletonCard title="Confluence" rows={4} className="min-h-[248px]" />
    );
  }

  const score = confluence.score;
  const angle = scoreToAngle(score);
  const needle = polarToCartesian(angle, RADIUS - 14);
  const regime = REGIME_LABEL[confluence.regime];

  return (
    <section className="rounded-lg border border-edge bg-panel p-4">
      <header className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Confluence Score
        </h3>
        <span
          className="rounded px-2 py-0.5 text-[10px] font-bold tracking-wider"
          style={{ color: regime.color, backgroundColor: `${regime.color}1a` }}
        >
          {regime.text}
        </span>
      </header>

      <div className="mt-1 flex justify-center">
        <svg width={SIZE} height={SIZE / 2 + 34} role="img" aria-label={`Confluence score ${score}`}>
          <defs>
            <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#ef5350" />
              <stop offset="50%" stopColor="#f59e0b" />
              <stop offset="100%" stopColor="#26a69a" />
            </linearGradient>
          </defs>

          {/* Track + gradient arc (180° semicircle). */}
          <path
            d={arcPath(180, 0, RADIUS)}
            fill="none"
            stroke="#1e293b"
            strokeWidth={14}
            strokeLinecap="round"
          />
          <path
            d={arcPath(180, 0, RADIUS)}
            fill="none"
            stroke="url(#gaugeGradient)"
            strokeWidth={14}
            strokeLinecap="round"
            opacity={0.9}
          />

          {/* Tick marks at -100 / -50 / 0 / 50 / 100. */}
          {[-100, -50, 0, 50, 100].map((tick) => {
            const a = scoreToAngle(tick);
            const outer = polarToCartesian(a, RADIUS + 10);
            const inner = polarToCartesian(a, RADIUS + 3);
            const label = polarToCartesian(a, RADIUS + 20);
            return (
              <g key={tick}>
                <line
                  x1={inner.x}
                  y1={inner.y}
                  x2={outer.x}
                  y2={outer.y}
                  stroke="#475569"
                  strokeWidth={1.5}
                />
                <text
                  x={label.x}
                  y={label.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={9}
                  fill="#64748b"
                  fontFamily="ui-monospace, monospace"
                >
                  {tick > 0 ? `+${tick}` : tick}
                </text>
              </g>
            );
          })}

          {/* Needle. */}
          <line
            x1={CENTER_X}
            y1={CENTER_Y}
            x2={needle.x}
            y2={needle.y}
            stroke="#e2e8f0"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          <circle cx={CENTER_X} cy={CENTER_Y} r={5} fill="#e2e8f0" />

          {/* Score readout. */}
          <text
            x={CENTER_X}
            y={CENTER_Y - 34}
            textAnchor="middle"
            fontSize={30}
            fontWeight={700}
            fill={regime.color}
            fontFamily="ui-monospace, monospace"
          >
            {score >= 0 ? `+${score.toFixed(0)}` : score.toFixed(0)}
          </text>
          <text
            x={CENTER_X}
            y={CENTER_Y - 18}
            textAnchor="middle"
            fontSize={9}
            fill="#64748b"
            letterSpacing={2}
          >
            CONFIDENCE {(confluence.confidence * 100).toFixed(0)}%
          </text>
        </svg>
      </div>

      {/* Component breakdown bars (weights shown). */}
      <div className="mt-2 space-y-2">
        <ComponentBar
          label="Technical"
          weight="35%"
          value={confluence.technical}
          detail={confluence.technical_detail.rsi != null ? `RSI ${confluence.technical_detail.rsi.toFixed(1)}` : undefined}
        />
        <ComponentBar
          label="Sentiment"
          weight="35%"
          value={confluence.sentiment}
          detail={
            confluence.sentiment_detail.weighted_polarity != null
              ? `p ${confluence.sentiment_detail.weighted_polarity.toFixed(2)} · n=${confluence.sentiment_detail.sample_size}`
              : `n=${confluence.sentiment_detail.sample_size}`
          }
        />
        <ComponentBar
          label="Derivatives"
          weight="30%"
          value={confluence.derivative}
          detail={
            confluence.derivative_detail.funding_rate != null
              ? `fund ${(confluence.derivative_detail.funding_rate * 100).toFixed(3)}%`
              : undefined
          }
        />
      </div>

      {confluence.warnings.length > 0 && (
        <p className="mt-3 rounded border border-warn/30 bg-warn/5 px-2 py-1 text-[10px] leading-relaxed text-warn">
          {confluence.warnings.join(" · ")}
        </p>
      )}
    </section>
  );
}

function ComponentBar({
  label,
  weight,
  value,
  detail,
}: {
  label: string;
  weight: string;
  value: number;
  detail?: string;
}) {
  const pct = ((value + 1) / 2) * 100;
  const color = value > 0.05 ? "#26a69a" : value < -0.05 ? "#ef5350" : "#f59e0b";
  return (
    <div>
      <div className="flex items-baseline justify-between text-[10px] text-slate-400">
        <span className="uppercase tracking-wider">
          {label} <span className="text-slate-600">{weight}</span>
        </span>
        <span className="font-mono text-slate-300">{detail ?? ""}</span>
      </div>
      <div className="relative mt-1 h-1.5 overflow-hidden rounded bg-edge">
        <div
          className="absolute inset-y-0 transition-all duration-500"
          style={{ left: `${Math.min(50, pct)}%`, width: `${Math.abs(pct - 50)}%`, backgroundColor: color }}
        />
        <div className="absolute inset-y-0 left-1/2 w-px bg-slate-500" />
      </div>
    </div>
  );
}
