import { authenticated } from '@/server/authenticated';
import { chooseCity, readCity } from '@/server/city';
import { identityStatus } from '@/server/eudi';
import { getStore } from '@/server/store';
import { readBody, sameOrigin } from '@/server/http';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };

async function view(request: Request) {
  const identity = await authenticated(request);
  const store = await getStore();
  const status = await identityStatus(store, identity);
  return readCity(store, identity, status.state === 'verified' ? status.statement.city : undefined);
}

/** The person's city through the Stadtstack project atlas: EU-wallet city first, else a chosen one. */
export async function GET(request: Request) {
  try {
    return Response.json({ city: await view(request) }, noStore);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unavailable' }, { status: 401 });
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    await chooseCity(await getStore(), identity, String(body.city ?? ''));
    return Response.json({ city: await view(request) }, noStore);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Please try again.' }, { status: 409 });
  }
}
