import { authenticated } from '@/server/authenticated';
import { readCityFeed } from '@/server/city-signals';
import { errorResponse } from '@/server/http';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' };

/** Serve only published city-wide records; personal pins never reach this route. */
export async function GET(request: Request) {
  try {
    await authenticated(request);
  } catch (error) {
    return errorResponse(error);
  }
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== 'city') || params.getAll('city').length !== 1 || !params.get('city'))
    return Response.json({ error: 'Only a public city ID is accepted. Home and work stay on your device.' }, { status: 400, headers });
  try {
    return Response.json(await readCityFeed(params.get('city')!), { headers });
  } catch (error) {
    console.error('City feed unavailable:', error);
    return Response.json({ error: 'City feed is temporarily unavailable.' }, { status: 503, headers });
  }
}
