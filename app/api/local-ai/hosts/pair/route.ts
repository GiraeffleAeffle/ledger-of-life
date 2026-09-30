import { errorResponse } from '../../../../../src/server/http.ts';
import { createHostPairing, parseConnectorBody, readConnectorBody } from '../../../../../src/server/local-ai-hosts.ts';
import { getStore } from '../../../../../src/server/store.ts';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const raw = await readConnectorBody(request, 2048);
    // This untrusted source hint is only a coarse bounded limiter, never invitation or host capacity.
    const address = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || request.headers.get('x-real-ip') || 'unknown';
    const result = await createHostPairing(await getStore(), parseConnectorBody(raw), address);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
