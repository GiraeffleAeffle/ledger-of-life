import { authenticated } from '@/server/authenticated';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { prepareOwnershipExample, readOwnershipPreparation } from '@/server/ownership-demo';
import { getStore } from '@/server/store';

export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };

/** Read-only reservation status; GET never starts setup, signs, mints, or transfers gas. */
export async function GET(request: Request) {
  try {
    const identity = await authenticated(request);
    return Response.json({ preparation: await readOwnershipPreparation(await getStore(), identity) }, noStore);
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('Vary', 'Authorization');
    return response;
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    if (body.action !== 'prepare_example_shares') throw new Error('Unknown example-share action.');
    const store = await getStore();
    return Response.json({ preparation: await prepareOwnershipExample(store, identity) }, noStore);
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('Vary', 'Authorization');
    return response;
  }
}
