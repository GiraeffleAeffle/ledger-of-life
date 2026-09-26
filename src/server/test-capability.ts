import { solanaConfiguration } from './solana-rpc.ts';
import { assertTestSignerAllowed } from './test-signer.ts';

/** Operator-controlled deployment capability; request hostnames are not a trust boundary. */
export function operatorTestCapability(environment: Record<string, string | undefined> = process.env) {
  if (environment.VERCEL || (environment.NODE_ENV === 'production' && environment.ALLOW_OPERATOR_TEST_ACTIONS !== '1')) return false;
  const config = solanaConfiguration(environment);
  if (!config) return false;
  try {
    assertTestSignerAllowed(environment, config);
    return true;
  } catch {
    return false;
  }
}
