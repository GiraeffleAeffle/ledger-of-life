import { authenticated } from '@/server/authenticated';
import { addPlace, listPlaces, removePlace } from '@/server/timeline';
import { getStore } from '@/server/store';
import { readBody, sameOrigin } from '@/server/http';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };

export async function GET(request: Request) {
  try {
    const identity = await authenticated(request);
    return Response.json({ places: await listPlaces(await getStore(), identity) }, noStore);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unavailable' }, { status: 401 });
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    const store = await getStore();
    let places;
    if (body.action === 'add') places = await addPlace(store, identity, { city: body.city, from: body.from, to: body.to, note: body.note });
    else if (body.action === 'remove' && typeof body.id === 'string') places = await removePlace(store, identity, body.id);
    else throw new Error('Choose a timeline action.');
    return Response.json({ places }, noStore);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Please try again.' }, { status: 409 });
  }
}
