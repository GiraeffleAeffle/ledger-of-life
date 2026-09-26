import { authenticated } from '@/server/authenticated';
import { forgetIdentity, identityStatus, pollIdentityRequest, startIdentityRequest } from '@/server/eudi';
import { getStore } from '@/server/store';
import { readBody, sameOrigin } from '@/server/http';
export const runtime = 'nodejs';
const noStore = { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } };

/** EU Digital Identity Wallet status for the signed-in person. */
export async function GET(request: Request) {
  try {
    const identity = await authenticated(request);
    return Response.json({ identity: await identityStatus(await getStore(), identity) }, noStore);
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
    if (body.action === 'start') return Response.json(await startIdentityRequest(store, identity), noStore);
    if (body.action === 'poll') return Response.json({ identity: await pollIdentityRequest(store, identity) }, noStore);
    if (body.action === 'forget') {
      await forgetIdentity(store, identity);
      return Response.json({ identity: { state: 'none' } }, noStore);
    }
    throw new Error('Unknown action.');
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Please try again.' }, { status: 409 });
  }
}
