import { authenticated } from '@/server/authenticated';
import { readCitySignals } from '@/server/city-signals';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' };

/** Public city-wide files only. Reject all location filters rather than accidentally recording private coordinates. */
export async function GET(request: Request) {
  try {
    await authenticated(request);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Sign in again.' }, { status: 401, headers });
  }
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== 'city') || params.getAll('city').length > 1) {
    return Response.json({ error: 'Only a city ID is accepted. Home, work, and map coordinates stay on your device.' }, { status: 400, headers });
  }
  try {
    const result = await readCitySignals(params.get('city') ?? '');
    return Response.json(result, { headers });
  } catch (error) {
    console.error('City signals files unavailable:', error);
    return Response.json({ error: 'City signals are temporarily unavailable.' }, { status: 503, headers });
  }
}
