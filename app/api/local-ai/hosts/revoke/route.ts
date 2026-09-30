import { WorkflowError } from '../../../../../src/domain/errors.ts';
import { authenticated } from '../../../../../src/server/authenticated.ts';
import { errorResponse, sameOrigin } from '../../../../../src/server/http.ts';
import { parseConnectorBody, readConnectorBody, revokeConnectorHost } from '../../../../../src/server/local-ai-hosts.ts';
import { getStore } from '../../../../../src/server/store.ts';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = parseConnectorBody(await readConnectorBody(request, 1024));
    if (typeof body.hostId !== 'string' || body.hostId.length > 64 || Object.keys(body).some((key) => key !== 'hostId'))
      throw new WorkflowError('A host ID is required.');
    return Response.json(await revokeConnectorHost(await getStore(), identity, body.hostId), { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } });
  } catch (error) { return errorResponse(error); }
}
