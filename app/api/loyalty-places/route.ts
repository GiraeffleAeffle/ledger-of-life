import { authenticated } from '@/server/authenticated';
import { errorResponse } from '@/server/http';
import { readLoyaltyPlaces } from '@/server/loyalty-places';
import { isCivicCity } from '@/data/civic-cities';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' };

export async function GET(request: Request) {
  try { await authenticated(request); } catch (error) { return errorResponse(error); }
  const params = new URL(request.url).searchParams;
  const city = params.get('city');
  if ([...params.keys()].some((key) => key !== 'city') || params.getAll('city').length !== 1 || !city || !isCivicCity(city))
    return Response.json({ error: 'Choose a supported civic city. Only its public ID is accepted.' }, { status: 400, headers });
  return Response.json(readLoyaltyPlaces(city), { headers });
}
