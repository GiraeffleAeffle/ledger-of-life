import { authenticated } from '@/server/authenticated';
import { identityStatus } from '@/server/eudi';
import { getStore } from '@/server/store';
import { readCity } from '@/server/city';
import { readSignalsCatalogue } from '@/server/city-signals';
import { locateCity } from '@/server/places-live';
import { errorResponse } from '@/server/http';
import { nearestCoveredCity } from '@/components/city-coverage';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' };

export async function GET(request: Request) {
  try {
    const identity = await authenticated(request);
    const store = await getStore();
    const status = await identityStatus(store, identity);
    const city = await readCity(store, identity, status.state === 'verified' ? status.statement.city : undefined);
    if (!city.name || city.cityId) return Response.json({ nearest: null }, { headers });
    const location = await locateCity(city.name);
    if (location.state !== 'available') return Response.json({ nearest: null }, { headers });
    const { cities } = await readSignalsCatalogue();
    const nearest = nearestCoveredCity(cities, [location.value.lon, location.value.lat]);
    return Response.json({ nearest: nearest ? { id: nearest.id, name: nearest.name } : null }, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}
