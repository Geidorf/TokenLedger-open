// LoadingSkeleton is the placeholder block set the dashboard shows while
// the first get_cached_stats() round-trip is in flight. We keep the
// silhouette matching the metric-card / panel / heatmap layout of the
// real dashboard well enough to feel "loading" instead of "blank".
//
// Two flavours are exported:
//   - <LoadingSkeleton className="h-64" />  : a single panel-sized block
//     used by the dashboard and logs tabs while they wait for data.
//   - <MetricsSkeleton /> : the four-up metric-card row used at the
//     top of the dashboard while stats are still loading.
//
// Animations are CSS-only via the `skeleton-pulse` class in
// index.css. Data-loading orchestration lives in App.tsx; this file
// stays presentation-only.

interface LoadingSkeletonProps {
  className?: string;
}

export function LoadingSkeleton({ className = 'h-64' }: LoadingSkeletonProps) {
  return (
    <div className={`panel skeleton-panel ${className}`} aria-busy="true" aria-live="polite">
      <div className="panel-title skeleton-line skeleton-line-title skeleton-pulse" />
      <div className="skeleton-block chart-fill skeleton-pulse" />
    </div>
  );
}

export function MetricsSkeleton() {
  return (
    <div className="metrics-grid" aria-busy="true" aria-live="polite" aria-label="正在加载指标概览">
      {Array.from({ length: 4 }).map((_, idx) => (
        <div key={idx} className="metric-card is-skeleton">
          <div className="metric-icon skeleton-block skeleton-pulse" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="skeleton-line skeleton-line-short skeleton-pulse" />
            <div className="skeleton-line skeleton-line-value skeleton-pulse" />
            <div className="skeleton-line skeleton-line-sub skeleton-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default LoadingSkeleton;
