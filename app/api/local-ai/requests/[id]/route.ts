import { assertVisitorActive, visitorToken } from '@/server/local-ai-session';
import { authenticated } from '@/server/authenticated';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { getStore } from '@/server/store';
import { executeAiRequest, libraryOwner, paidOwnerForRequest, readAiRequest, type AiOwner } from '@/server/local-ai';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { AccessError } from '@/server/errors';
import type { LocalAiRequest } from '@/server/local-ai-types';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie' };
function result(request: LocalAiRequest, savedRead = false) {
  const responseHeaders = new Headers(headers);
  if (request.mode === 'paid' && request.paymentRequired && request.payment.state !== 'settled')
    responseHeaders.set('PAYMENT-REQUIRED', encodePaymentRequiredHeader(request.paymentRequired));
  if (request.mode === 'paid' && !request.solanaReview && request.payment.state === 'settled' && request.payment.receipt)
    responseHeaders.set('PAYMENT-RESPONSE', encodePaymentResponseHeader(request.payment.receipt));
  // Library cookies are established before inference, never reissued by a paid or model response.
  // Reading an owned saved resource succeeds even when its inference failed.
  // Keep action failures distinct from transport/authentication failures.
  const status = savedRead ? 200 : request.state === 'failed' ? 502 : request.state === 'interrupted' ? 503 :
    request.state === 'expired' ? 410 :
    request.state === 'payment_required' || request.state === 'approval_required' ? 402 :
    request.state === 'completed' ? 200 : 202;
  return Response.json({ request }, { status, headers: responseHeaders });
}
function failure(error: unknown) {
  const response = errorResponse(error);
  response.headers.set('Cache-Control', headers['Cache-Control']); response.headers.set('Vary', headers.Vary);
  return response;
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    sameOrigin(request);
    const body = await readBody(request, 5000);
    const { id } = await params;
    const store = await getStore();
    let owner: AiOwner;
    let visitor: string | null = null;
    if (body.mode === 'paid') owner = await paidOwnerForRequest(store, id, await authenticated(request));
    else {
      if (body.mode !== 'library' || process.env.LOCAL_AI_LIBRARY_ENABLED !== '1') throw new AccessError('Public library inference is not enabled.');
      visitor = visitorToken(request);
      if (!visitor) return Response.json({ error: 'Start a private library session before requesting inference.' },
        { status: 428, headers });
      await assertVisitorActive(store, visitor);
      owner = libraryOwner(visitor);
    }
    const resourceUrl = new URL(`/api/local-ai/requests/${id}`, request.url).toString();
    const response = await executeAiRequest(store, id, owner, body, resourceUrl, request.headers.get('payment-signature'));
    if (visitor) await assertVisitorActive(store, visitor);
    return result(response);
  } catch (error) { return failure(error); }
}
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const store = await getStore();
    const id = (await params).id;
    const owner = request.headers.has('authorization') ? await paidOwnerForRequest(store, id, await authenticated(request)) : libraryOwner(visitorToken(request) || '');
    return result(await readAiRequest(store, id, owner), true);
  } catch (error) { return failure(error); }
}
