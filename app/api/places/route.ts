import { authenticated } from '@/server/authenticated';
import { identityStatus } from '@/server/eudi';
import { getStore } from '@/server/store';
import { readCity } from '@/server/city';
import { readPlaces } from '@/server/places-live';

export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };

/** Same verified-wallet-city-then-chosen-city precedence as /api/city, even if the atlas is offline. */
export async function GET(request: Request) {
  try {
    const identity = await authenticated(request);
    const store = await getStore();
    const status = await identityStatus(store, identity);
    const city = await readCity(store, identity, status.state === 'verified' ? status.statement.city : undefined);
    if (!city.name) return Response.json({ places: null, reason: city.available ? 'choose' : city.reason }, noStore);
    return Response.json({ places: await readPlaces(city.name) }, noStore);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unavailable' }, { ...noStore, status: 401 });
  }
}
