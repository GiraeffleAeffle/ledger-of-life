import { signedHostRoute } from '../../local-ai/hosts/_http.ts';
import { recordNodeReading } from '../../../../src/server/home-node.ts';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return signedHostRoute(request, 4096, recordNodeReading);
}
