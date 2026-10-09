import { isCivicCity } from '../data/civic-cities.ts';

/** Opens a reviewable native draft; a source URL never publishes a topic or imports a decision. */
export function civicSourceDraftHref(cityId: string, title: string, sourceUrl: string): string | null {
  if (!isCivicCity(cityId) || !title.trim() || title.length > 512 || sourceUrl.length > 2048) return null;
  try {
    const source = new URL(sourceUrl);
    if (source.protocol !== 'https:' || source.username || source.password) return null;
    const query = new URLSearchParams({ area: 'places', tab: 'places-say', civicCity: cityId, civicTitle: title, civicSource: source.href });
    return `/?${query}`;
  } catch { return null; }
}
