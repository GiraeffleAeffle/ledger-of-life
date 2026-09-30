import { authenticated } from '@/server/authenticated';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { getStore } from '@/server/store';
import { paidOwner } from '@/server/local-ai';
import { aiApproval } from '@/server/local-ai-operations';

export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const owner = paidOwner(await authenticated(request));
    const body = await readBody(request, 24000);
    const approval = await aiApproval(await getStore(), (await params).id, owner, body.action, body.signedTransaction);
    return Response.json({ approval }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } });
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
}
