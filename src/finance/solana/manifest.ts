import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";

export const SOLANA_IDS = Object.freeze({
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  klend: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
  instructions: "Sysvar1nstructions1111111111111111111111111",
  system: "11111111111111111111111111111111",
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
});
export const SOLANA_MAINNET_MANIFEST = Object.freeze({
  network: "solana" as const,
  cluster: "mainnet-beta" as const,
  genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  deposit: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenProgram: SOLANA_IDS.token, decimals: 6 },
  investment: { mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", tokenProgram: SOLANA_IDS.token2022, decimals: 8, symbol: "SPYx" },
  kamino: { program: SOLANA_IDS.klend, market: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF", reserve: "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59" },
  evidence: "mainnet-reference-read-only" as const,
});
export const SOLANA_DEVNET_MANIFEST = Object.freeze({
  network: "solana" as const,
  cluster: "devnet" as const,
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  deposit: { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", tokenProgram: SOLANA_IDS.token, decimals: 6 },
  evidence: "test-assets-only" as const,
});
export type Cluster = "mainnet-beta" | "devnet" | "localnet";
export type DeploymentManifest = {
  cluster: "devnet" | "localnet";
  genesisHash: string;
  escrowProgram: string;
  programSha256: string;
  /** Legacy manifests omit this field; pull payouts require a separately pinned deployment. */
  escrowVersion?: "direct-v1" | "pull-v2";
  depositMint: string;
  market: string;
  reserve: string;
  receiptMint: string;
  liquiditySupply: string;
  marketAuthority: string;
  oracleAccounts: readonly string[];
  maxObservationAgeMs: number;
};
export type Availability<T> = { available: true; value: T } | { available: false; reason: string };

/** Reference mainnet addresses do not enable writes. No deployment is implicit. */
export function resolveSolanaManifest(input: {
  cluster: Cluster; genesisHash: string; deployment?: DeploymentManifest;
}): Availability<DeploymentManifest> {
  if (input.cluster === "mainnet-beta") return { available: false, reason: "mainnet-writes-disabled" };
  const deployment = input.deployment;
  if (!deployment) return { available: false, reason: "escrow-deployment-not-configured" };
  if (deployment.cluster !== input.cluster || deployment.genesisHash !== input.genesisHash ||
    (input.cluster === "devnet" && input.genesisHash !== SOLANA_DEVNET_MANIFEST.genesisHash)) {
    return { available: false, reason: "cluster-genesis-mismatch" };
  }
  if (deployment.depositMint !== SOLANA_DEVNET_MANIFEST.deposit.mint) return { available: false, reason: "test-mint-required" };
  if (deployment.escrowVersion !== undefined && !["direct-v1", "pull-v2"].includes(deployment.escrowVersion)) return { available: false, reason: "invalid-escrow-version" };
  if (deployment.escrowVersion === "pull-v2" &&
    (deployment.escrowProgram === "B1hjmapwssey8AbpjAtw5qF87DvvtuSisGov4kHec7Yc" ||
      deployment.escrowProgram === "BiwaGavQUsSsg48UPpRAGWoXSiUnzgvdDs7rd8WizvPD" ||
      deployment.programSha256 === "29b7a9877bb8dacfa170ecf13e7c112a88d6dd3355e006b79975a25baefaae41" ||
      deployment.programSha256 === "03193455b06f9ee8c6f96ff5504f5fb97fb3ed839164676e3e9afcec55ca4377"))
    return { available: false, reason: "pull-payout-program-not-deployed" };
  try {
    for (const key of [deployment.escrowProgram, deployment.market, deployment.reserve, deployment.receiptMint, deployment.liquiditySupply, deployment.marketAuthority, ...deployment.oracleAccounts]) address(key);
    if (!/^[a-f0-9]{64}$/.test(deployment.programSha256) || !Number.isSafeInteger(deployment.maxObservationAgeMs) || deployment.maxObservationAgeMs <= 0 || deployment.maxObservationAgeMs > 60_000) throw new Error("Invalid deployment bounds");
  } catch { return { available: false, reason: "invalid-deployment-manifest" }; }
  return { available: true, value: deployment };
}

/** New-reserve PDA convention only: legacy vault/mint identities must come from validated reserve state. */
export async function deriveKaminoAddresses(reserve: string, market: string) {
  const encoder = getAddressEncoder();
  const derive = async (seed: string, key: string) => (await getProgramDerivedAddress({ programAddress: address(SOLANA_IDS.klend), seeds: [new TextEncoder().encode(seed), encoder.encode(address(key))] }))[0];
  const [receiptMint, liquiditySupply, marketAuthority] = await Promise.all([
    derive("reserve_coll_mint", reserve), derive("reserve_liq_supply", reserve), derive("lma", market),
  ]);
  return { receiptMint, liquiditySupply, marketAuthority };
}
