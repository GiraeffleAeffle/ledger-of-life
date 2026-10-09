import { authenticated } from '../../../src/server/authenticated';
import { handleCivicAiRequest } from '../../../src/server/civic-ai';
import { getStore } from '../../../src/server/store';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return handleCivicAiRequest(request, { authenticate: authenticated, store: getStore });
}

export async function POST(request: Request) {
  return handleCivicAiRequest(request, { authenticate: authenticated, store: getStore });
}
