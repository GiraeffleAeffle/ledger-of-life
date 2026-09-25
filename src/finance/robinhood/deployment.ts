import { keccak256, type Hex } from 'viem';

// solc 0.8.28, optimizer 200, Cancun; contracts/evm/src/RentalEscrow.sol.
// Rebuild and review this fingerprint when Solidity or compiler settings change.
export const rentalEscrowRuntime = {
  length: 14960,
  normalizedHash: '0x4970e11b6a153f213c041ba6e995ad87015d427c9f74b30e37b271891f0d9fe8' as Hex,
  immutableOffsets: [
    604, 700, 764, 803, 999, 1066, 1133, 1218, 1340, 1379, 1446, 1527, 1740, 1838, 2134, 2302, 2436,
    2666, 2909, 3043, 3077, 3140, 3300, 3334, 3496, 3664, 3858, 4027, 5286, 5508, 5640, 5790, 5824,
    5984, 6018, 6060, 6093, 6171, 6316, 6455, 6630, 6869, 6904, 6995, 7215, 7250, 7312, 7347, 7569,
    7947, 8172, 8208, 8241, 8287, 8377, 8410, 8527, 8785, 8945, 8979, 9066, 9241, 9527, 9598, 9752,
    9875, 9908, 10127, 10533,
  ],
} as const;

/** Both the reviewed program and this deployment's exact immutable values must match. */
export function assertRentalEscrowRuntime(code: Hex, expectedDeploymentHash: Hex): void {
  if (
    !/^0x[0-9a-fA-F]+$/.test(code) ||
    code.length !== rentalEscrowRuntime.length * 2 + 2 ||
    keccak256(code).toLowerCase() !== expectedDeploymentHash.toLowerCase()
  ) {
    throw new Error('Escrow deployment code does not match the reviewed hash');
  }
  let normalized = code.slice(2);
  for (const start of rentalEscrowRuntime.immutableOffsets) {
    normalized =
      normalized.slice(0, start * 2) + '0'.repeat(64) + normalized.slice((start + 32) * 2);
  }
  if (keccak256(`0x${normalized}`) !== rentalEscrowRuntime.normalizedHash) {
    throw new Error('Escrow is not the compiled restricted RentalEscrow program');
  }
}
