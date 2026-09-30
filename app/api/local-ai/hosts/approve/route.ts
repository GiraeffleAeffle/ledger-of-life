import { authenticated } from '../../../../../src/server/authenticated.ts';
import { errorResponse, sameOrigin } from '../../../../../src/server/http.ts';
import { approveHostPairing, parseConnectorBody, readConnectorBody } from '../../../../../src/server/local-ai-hosts.ts';
import { getStore } from '../../../../../src/server/store.ts';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const raw = await readConnectorBody(request, 2048);
    const host = await approveHostPairing(await getStore(), identity, parseConnectorBody(raw));
    return Response.json({ host }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } });
  } catch (error) { return errorResponse(error); }
}
