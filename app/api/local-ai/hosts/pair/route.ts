import { errorResponse } from '../../../../../src/server/http.ts';
import { createHostPairing, parseConnectorBody, readConnectorBody } from '../../../../../src/server/local-ai-hosts.ts';
import { getStore } from '../../../../../src/server/store.ts';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const raw = await readConnectorBody(request, 2048);
    // Single-use owner invitations and bounded global capacity authorize pairing; no client IP is read.
    const result = await createHostPairing(await getStore(), parseConnectorBody(raw));
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
