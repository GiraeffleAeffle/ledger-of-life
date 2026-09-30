import { errorResponse } from '../../../../src/server/http.ts';
import { authenticateConnector, checkConnectorHeaders, parseConnectorBody, readConnectorBody, type ConnectorHost } from '../../../../src/server/local-ai-hosts.ts';
import { getStore, type Store } from '../../../../src/server/store.ts';

export async function signedHostRoute(request: Request, maxBytes: number, action: (store: Store, host: ConnectorHost, body: Record<string, unknown>) => Promise<unknown>) {
  try {
    checkConnectorHeaders(request);
    const raw = await readConnectorBody(request, maxBytes);
    const store = await getStore();
    const host = await authenticateConnector(store, request, raw);
    const body = parseConnectorBody(raw);
    return Response.json(await action(store, host, body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
