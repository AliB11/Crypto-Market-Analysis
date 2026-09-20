/**
 * Skeleton loaders with FIXED dimensions identical to their hydrated
 * counterparts – zero cumulative layout shift by construction.
 */

import clsx from "clsx";

export function SkeletonCard({
  title,
  rows = 3,
  className,
}: {
  title: string;
  rows?: number;
  className?: string;
}) {
  return (
    <section className={clsx("rounded-lg border border-edge bg-panel p-4", className)}>
      <header className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          {title}
        </h3>
        <div className="skeleton h-3 w-10 rounded" />
      </header>
      <div className="mt-4 space-y-2.5">
        {Array.from({ length: rows }).map((_, index) => (
          <div
            key={index}
            className="skeleton h-3.5 rounded"
            style={{ width: `${88 - index * 12}%` }}
          />
        ))}
      </div>
    </section>
  );
}

export function SkeletonRow({ width = "100%" }: { width?: string }) {
  return <div className="skeleton h-4 rounded" style={{ width }} />;
}
