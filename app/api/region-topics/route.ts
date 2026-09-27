import { authenticated } from '@/server/authenticated';
import { readRegionalTopics } from '@/server/city-signals';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' };

/** The only input is a public city ID. Device-local map pins are never sent. */
export async function GET(request: Request) {
  try {
    await authenticated(request);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Sign in again.' }, { status: 401, headers });
  }
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== 'city') || params.getAll('city').length !== 1 || !params.get('city'))
    return Response.json({ error: 'Only a public city ID is accepted. Home and work stay on your device.' }, { status: 400, headers });
  try {
    return Response.json(await readRegionalTopics(params.get('city')!), { headers });
  } catch (error) {
    console.error('Regional topics unavailable:', error);
    return Response.json({ error: 'Regional topics are temporarily unavailable.' }, { status: 503, headers });
  }
}
