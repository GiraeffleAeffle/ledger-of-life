import { authenticated } from '@/server/authenticated';
import { identityStatus } from '@/server/eudi';
import { getStore } from '@/server/store';
import { readCity } from '@/server/city';
import { readSignalsCatalogue } from '@/server/city-signals';
import { readPlaces } from '@/server/places-live';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };

/** Read the chosen city's context or an explicitly selected covered city's context. */
export async function GET(request: Request) {
  try {
    const identity = await authenticated(request);
    const store = await getStore();
    const status = await identityStatus(store, identity);
    const city = await readCity(store, identity, status.state === 'verified' ? status.statement.city : undefined);
    const explored = new URL(request.url).searchParams.get('city');
    const covered = explored ? (await readSignalsCatalogue()).cities.find((item) => item.id === explored) : undefined;
    if (explored && !covered) return Response.json({ error: 'Choose a covered city.' }, { status: 400, ...noStore });
    if (!covered && !city.cityId) return Response.json({ places: null, reason: city.name ? 'not_covered' : 'choose' }, noStore);
    const name = covered?.name ?? city.name;
    if (!name) return Response.json({ places: null, reason: 'choose' }, noStore);
    return Response.json({ places: await readPlaces(name) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}
