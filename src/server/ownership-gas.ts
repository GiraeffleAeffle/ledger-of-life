const MAX_FEE_PER_GAS = 20_000_000_000n;
const MAX_TRANSFER_GAS = 500_000n;
const MAX_DEPLOY_GAS = 6_000_000n;

/** Robinhood/Arbitrum includes posting fees in gas units: estimate the exact call, then cap headroom. */
export function reviewedOperatorGas(estimated: bigint, kind: 'transfer' | 'deploy') {
  if (estimated <= 0n) throw new Error('A positive testnet gas estimate is required.');
  const limit = estimated * 125n / 100n + 10_000n;
  if (limit > (kind === 'deploy' ? MAX_DEPLOY_GAS : MAX_TRANSFER_GAS))
    throw new Error('Estimated operator gas exceeds the reviewed testnet ceiling; no transaction was signed.');
  return limit;
}
export function reviewedOperatorFees(fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }) {
  if (!fees.maxFeePerGas || fees.maxFeePerGas <= 0n) throw new Error('Testnet fee quote unavailable; no transaction was signed.');
  const maxFeePerGas = fees.maxFeePerGas * 2n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
  if (maxFeePerGas > MAX_FEE_PER_GAS || maxPriorityFeePerGas > maxFeePerGas)
    throw new Error('Operator fee quote exceeds the reviewed testnet ceiling; no transaction was signed.');
  return { maxFeePerGas, maxPriorityFeePerGas };
}
