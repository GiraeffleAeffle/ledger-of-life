import { authenticated } from '@/server/authenticated';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { getStore } from '@/server/store';
import { paidOwnerForRequest } from '@/server/local-ai';
import { aiApproval } from '@/server/local-ai-operations';

export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const store = await getStore();
    const id = (await params).id;
    const owner = await paidOwnerForRequest(store, id, identity);
    const body = await readBody(request, 24000);
    const approval = await aiApproval(store, id, owner, body.action, body.signedTransaction, identity);
    return Response.json({ approval }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } });
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
}
