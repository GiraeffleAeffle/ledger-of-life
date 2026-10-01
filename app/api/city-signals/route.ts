import { authenticated } from '@/server/authenticated';
import { readCitySignal, readCitySignals } from '@/server/city-signals';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' };

/** Public city-wide records only. Reject private location filters and all unrecognised parameters. */
export async function GET(request: Request) {
  try {
    await authenticated(request);
  } catch (error) {
    return errorResponse(error);
  }
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== 'city' && key !== 'id') || params.getAll('city').length > 1 || params.getAll('id').length > 1 || (params.has('id') && (!params.get('id') || !params.get('city')))) {
    return Response.json({ error: 'Only a city ID and optional public signal ID are accepted. Home, work, and map coordinates stay on your device.' }, { status: 400, headers });
  }
  try {
    if (params.has('id')) {
      const feature = await readCitySignal(params.get('city')!, params.get('id')!);
      return feature ? Response.json({ feature }, { headers }) : Response.json({ error: 'Public city item not found.' }, { status: 404, headers });
    }
    const result = await readCitySignals(params.get('city') ?? '');
    return Response.json(result, { headers });
  } catch {
    console.error('City signals files unavailable.');
    return Response.json({ error: 'City signals are temporarily unavailable.' }, { status: 503, headers });
  }
}
