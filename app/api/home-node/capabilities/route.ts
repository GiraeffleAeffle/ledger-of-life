import { signedHostRoute } from '../../local-ai/hosts/_http.ts';
import { recordNodeCapabilities } from '../../../../src/server/home-node.ts';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return signedHostRoute(request, 16384, recordNodeCapabilities);
}
