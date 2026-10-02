import { authenticated } from '../../../../src/server/authenticated.ts';
import { errorResponse } from '../../../../src/server/http.ts';
import { operatorHomeNodes } from '../../../../src/server/home-node.ts';
import { getStore } from '../../../../src/server/store.ts';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try { return Response.json(await operatorHomeNodes(await getStore(), await authenticated(request)), { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } }); }
  catch (error) { return errorResponse(error); }
}
