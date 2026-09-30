import { recordHostHeartbeat } from '../../../../../src/server/local-ai-hosts.ts';
import { signedHostRoute } from '../_http.ts';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  return signedHostRoute(request, 8192, (store, host, body) => recordHostHeartbeat(store, host.id, body));
}
