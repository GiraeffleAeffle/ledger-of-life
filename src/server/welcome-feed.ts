import 'server-only';
import { readCityFeed } from './city-signals';
import type { CityFeedItem } from './city-signals';

/** Read only the same published city feed used in Places. No visitor data enters this call. */
export async function readWelcomeFeed(cityId: string): Promise<{ items: CityFeedItem[]; generatedAt: string | null }> {
  const result = await readCityFeed(cityId);
  return result.state === 'available'
    ? { items: result.feed.items, generatedAt: result.feed.generatedAt }
    : { items: [], generatedAt: null };
}
