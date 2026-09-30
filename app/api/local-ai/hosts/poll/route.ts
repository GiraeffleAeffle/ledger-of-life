import { WorkflowError } from '../../../../../src/domain/errors.ts';
import { pollConnectorJob } from '../../../../../src/server/local-ai-hosts.ts';
import { signedHostRoute } from '../_http.ts';

export const runtime = 'nodejs';
export const maxDuration = 30;
export async function POST(request: Request) {
  return signedHostRoute(request, 1024, async (store, host, body) => {
    if (Object.keys(body).length) throw new WorkflowError('Poll body must be an empty object.');
    return pollConnectorJob(store, host.id, undefined, undefined, request.signal);
  });
}
