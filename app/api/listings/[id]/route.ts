import { authenticated } from '@/server/authenticated';
import { applyToListing, chooseApplicant } from '@/server/listings';
import { getStore } from '@/server/store';
import { errorResponse, readBody, sameOrigin } from '@/server/http';
import { WorkflowError } from '@/domain/workflow';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  try {
    sameOrigin(request);
    const identity = await authenticated(request);
    const body = await readBody(request);
    const store = await getStore();
    const { id } = await context.params;
    const listing =
      body.action === 'apply'
        ? await applyToListing(store, identity, id, body)
        : body.action === 'choose'
          ? await chooseApplicant(store, identity, id, body.applicationId)
          : null;
    if (!listing) throw new WorkflowError('Choose apply or choose.');
    return Response.json({ listing }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
