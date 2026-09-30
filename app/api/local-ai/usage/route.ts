import { errorResponse } from '@/server/http';
import { getStore } from '@/server/store';
import { localAiUsage } from '@/server/local-ai-operations';

export const runtime = 'nodejs';
export async function GET() {
  try {
    return Response.json({ usage: await localAiUsage(await getStore()) },
      { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
