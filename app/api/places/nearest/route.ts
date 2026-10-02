import { authenticated } from '@/server/authenticated';
import { getStore } from '@/server/store';
import { personCity } from '@/server/person-city';
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
    const city = await personCity(store, identity);
    if (!city.name || city.cityId) return Response.json({ nearest: null }, { headers });
    const pin = city.home?.location;
    const location = pin ? null : await locateCity(city.name);
    if (!pin && location?.state !== 'available') return Response.json({ nearest: null }, { headers });
    const point = pin ?? (location?.state === 'available' ? location.value : null);
    if (!point) return Response.json({ nearest: null }, { headers });
    const { cities } = await readSignalsCatalogue();
    const nearest = nearestCoveredCity(cities, [point.lon, point.lat]);
    return Response.json({ nearest: nearest ? { id: nearest.id, name: nearest.name } : null }, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}
