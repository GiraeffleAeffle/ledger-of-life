import { authenticated } from '../../../src/server/authenticated';
import { handleCivicRequest } from '../../../src/server/civic';
import { getStore } from '../../../src/server/store';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return handleCivicRequest(request, { authenticate: authenticated, store: getStore });
}

export async function POST(request: Request) {
  return handleCivicRequest(request, { authenticate: authenticated, store: getStore });
}
