import { WorkflowError } from '../../../../src/domain/errors.ts';
import { authenticated } from '../../../../src/server/authenticated.ts';
import { errorResponse, sameOrigin } from '../../../../src/server/http.ts';
import { assignNodeSolar } from '../../../../src/server/home-node.ts';
import { parseConnectorBody, readConnectorBody } from '../../../../src/server/local-ai-hosts.ts';
import { getStore } from '../../../../src/server/store.ts';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = parseConnectorBody(await readConnectorBody(request, 1024));
    if (Object.keys(body).some(key => !['hostId', 'assignSolarToBuilding', 'peakCapacityKwp'].includes(key)) || typeof body.hostId !== 'string' || !body.hostId || body.hostId.length > 64 || typeof body.assignSolarToBuilding !== 'boolean' || (body.assignSolarToBuilding && typeof body.peakCapacityKwp !== 'number')) throw new WorkflowError('Choose a node, an explicit solar assignment and declared peak capacity in kWp.');
    return Response.json(await assignNodeSolar(await getStore(), identity, body.hostId, body.assignSolarToBuilding, body.assignSolarToBuilding ? body.peakCapacityKwp as number : null), { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } });
  } catch (error) { return errorResponse(error); }
}
