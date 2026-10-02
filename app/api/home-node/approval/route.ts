import { WorkflowError } from '../../../../src/domain/errors.ts';
import { authenticated } from '../../../../src/server/authenticated.ts';
import { errorResponse, sameOrigin } from '../../../../src/server/http.ts';
import { reviewNodeSolar } from '../../../../src/server/home-node.ts';
import { parseConnectorBody, readConnectorBody } from '../../../../src/server/local-ai-hosts.ts';
import { getStore } from '../../../../src/server/store.ts';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = parseConnectorBody(await readConnectorBody(request, 1024));
    if (Object.keys(body).some(key => !['hostId', 'approved'].includes(key)) || typeof body.hostId !== 'string' || !body.hostId || body.hostId.length > 64 || typeof body.approved !== 'boolean') throw new WorkflowError('Choose a node and approve or reject its solar assignment.');
    return Response.json(await reviewNodeSolar(await getStore(), identity, body.hostId, body.approved), { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } });
  } catch (error) { return errorResponse(error); }
}
