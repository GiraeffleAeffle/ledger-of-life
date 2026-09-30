import { errorResponse } from '../../../../../src/server/http.ts';
import { createHostPairing, parseConnectorBody, readConnectorBody } from '../../../../../src/server/local-ai-hosts.ts';
import { getStore } from '../../../../../src/server/store.ts';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const raw = await readConnectorBody(request, 2048);
    // Forwarded addresses are only a secondary bucket. The durable global cap
    // also applies, so rotating or spoofing these headers cannot bypass it.
    const address = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || request.headers.get('x-real-ip') || 'unknown';
    const result = await createHostPairing(await getStore(), parseConnectorBody(raw), address);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
