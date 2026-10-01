import { parseEther } from 'viem';

/** Below this balance (0.00001 ETH) the site's gas drip tops a wallet up; at or above it the drip refuses. */
export const GAS_DRIP_THRESHOLD = 10_000_000_000_000n;

/** `ethBalance` is the formatted ether string the holdings read returns; unknown (undefined) is never "low". */
export function belowGasDripThreshold(ethBalance: string | undefined): boolean {
  if (ethBalance === undefined) return false;
  try { return parseEther(ethBalance) < GAS_DRIP_THRESHOLD; } catch { return false; }
}
