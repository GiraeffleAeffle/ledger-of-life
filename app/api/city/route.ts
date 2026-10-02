import { authenticated } from '@/server/authenticated';
import { chooseCity } from '@/server/city';
import { personCity } from '@/server/person-city';
import { getStore } from '@/server/store';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };

async function view(request: Request) {
  const identity = await authenticated(request);
  const store = await getStore();
  return personCity(store, identity);
}

/** Resolve the person's home city, explicit override or EU-wallet city. */
export async function GET(request: Request) {
  try {
    return Response.json({ city: await view(request) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    await chooseCity(await getStore(), identity, body.city === null ? null : String(body.city ?? ''));
    return Response.json({ city: await view(request) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}
