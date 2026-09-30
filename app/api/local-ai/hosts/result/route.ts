import { completeConnectorJob } from '../../../../../src/server/local-ai-hosts.ts';
import { signedHostRoute } from '../_http.ts';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  return signedHostRoute(request, 131072, (store, host, body) => completeConnectorJob(store, host.id, body));
}
