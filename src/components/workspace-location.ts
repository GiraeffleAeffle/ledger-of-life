import type { Area } from './areas';

const AREAS: Record<Area, true> = { overview: true, me: true, home: true, money: true, places: true, ideas: true };
export function areaFromSearch(search: string): Area {
  const value = new URLSearchParams(search).get('area');
  return value && Object.hasOwn(AREAS, value) ? value as Area : 'overview';
}
export function withArea(url: string, area: Area) {
  const next = new URL(url);
  if (area === 'overview') next.searchParams.delete('area');
  else next.searchParams.set('area', area);
  return next.pathname + next.search + next.hash;
}
export function tabFromSearch(search: string, ids: readonly string[]) {
  const tab = new URLSearchParams(search).get('tab');
  return tab && ids.includes(tab) ? tab : ids[0];
}
export function withTab(url: string, tab: string) {
  const next = new URL(url);
  next.searchParams.set('tab', tab);
  return next.pathname + next.search + next.hash;
}
