import { AREAS, type Area } from './areas';

export function AreaSkeleton({ area, bodyOnly = false }: { area: Area; bodyOnly?: boolean }) {
  const meta = AREAS.find((item) => item.id === area)!;
  const body = <div className={`area-skeleton area-skeleton--${area}`} aria-busy="true" aria-label={`Loading ${meta.label}`}>
    {area === 'money' && <div className="skeleton-block skeleton-tabs" />}
    <div className="skeleton-block skeleton-card" />
    {area === 'places' && <div className="skeleton-block skeleton-map" />}
    <span className="sr-only" role="status">Loading {meta.label}…</span>
  </div>;
  if (bodyOnly) return body;
  return <><div className="page-heading"><h1 tabIndex={-1}>{meta.label}</h1></div>{body}</>;
}
