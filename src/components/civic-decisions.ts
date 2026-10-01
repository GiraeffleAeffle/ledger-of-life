import type { CityFeature } from '../server/city-signals.ts';

export type CouncilRecord = { id: string; title: string; date: string | null; body: string; url: string };
/** Published agendas/papers only: never infer adoption from a record or modification date. */
export function selectCouncilRecords(features: CityFeature[], now: number, limit = 5) {
  const meetings: CouncilRecord[] = [];
  const papers: CouncilRecord[] = [];
  for (const feature of features) {
    const p = feature.properties;
    if (p.kind !== 'council_meeting' && p.kind !== 'council_paper') continue;
    const source = 'sources' in p ? p.sources[0] : p.primarySource;
    if (!source || !/^https?:\/\//.test(source.url)) continue;
    const bodyId = new URL(source.url).pathname.match(/\/bod(?:y|ies)\/([^/]+)/)?.[1];
    const record = { id: p.id, title: p.title, date: p.startDate, body: `${source.publisher}${bodyId ? ` · body ${bodyId}` : ' · body name not published'}`, url: source.url };
    if (p.kind === 'council_meeting') {
      if (p.startDate && Date.parse(p.startDate) >= now) meetings.push(record);
    } else papers.push(record);
  }
  meetings.sort((a, b) => Date.parse(a.date!) - Date.parse(b.date!) || a.id.localeCompare(b.id));
  papers.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.id.localeCompare(b.id));
  return { meetings: meetings.slice(0, limit), papers: papers.slice(0, limit) };
}
