import { getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import type { DeploymentManifest } from "./manifest.ts";
import { decodeTenancy, deriveEscrowAddresses } from "./program.ts";
import { messageDigest, reconcileSolanaSignature, type ConfirmedTransaction, type ExpectedTokenDelta, type RawTokenBalance } from "./reconcile.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RPC object unavailable");
  return value as Record<string, unknown>;
}
function integerString(value: unknown): string {
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error("Unsafe RPC integer");
}
function base64(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length > 40_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("Invalid RPC base64");
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
export async function readTenancy(input: { manifest: DeploymentManifest; tenancy: string }, request: (method: string, params: unknown[]) => Promise<unknown>) {
  const [genesisHash, raw] = await Promise.all([
    request("getGenesisHash", []),
    request("getAccountInfo", [input.tenancy, { encoding: "base64", commitment: "finalized" }]),
  ]);
  if (genesisHash !== input.manifest.genesisHash) throw new Error("RPC genesis mismatch");
  const result = object(raw);
  if (result.value === null) return { available: false as const, reason: "tenancy-account-not-found" };
  const row = object(result.value), context = object(result.context);
  if (!Array.isArray(row.data) || row.data[1] !== "base64" || typeof row.owner !== "string" || typeof row.executable !== "boolean") throw new Error("Invalid RPC account encoding");
  const tenancy = decodeTenancy({ address: input.tenancy, owner: row.owner, executable: row.executable, data: base64(row.data[0]) }, input.manifest);
  const derived = await deriveEscrowAddresses(input.manifest.escrowProgram, tenancy.tenant, tenancy.leaseId);
  if (derived.tenancy !== input.tenancy || derived.bump !== tenancy.bump) throw new Error("Invalid tenancy PDA");
  return { available: true as const, value: tenancy, slot: integerString(context.slot), genesisHash };
}

/** Read-only RPC reconciliation. Transport failure is unknown, never an invitation to duplicate intent. */
export async function observeSolanaSignature(input: {
  signature: string; genesisHash: string; expectedMessageSha256: string; expectedDeltas: readonly ExpectedTokenDelta[];
}, request: (method: string, params: unknown[]) => Promise<unknown>) {
  try {
    const [genesis, rawStatus, rawTransaction] = await Promise.all([
      request("getGenesisHash", []),
      request("getSignatureStatuses", [[input.signature], { searchTransactionHistory: true }]),
      request("getTransaction", [input.signature, { encoding: "base64", commitment: "finalized", maxSupportedTransactionVersion: 0 }]),
    ]);
    if (typeof genesis !== "string") throw new Error("RPC genesis unavailable");
    const statusEnvelope = object(rawStatus);
    if (!Array.isArray(statusEnvelope.value)) throw new Error("RPC status unavailable");
    const status = statusEnvelope.value[0] === null ? null : object(statusEnvelope.value[0]);
    if (status && (!("err" in status) || !["processed", "confirmed", "finalized", null].includes(status.confirmationStatus as string | null))) throw new Error("Invalid confirmation status");
    let transaction: ConfirmedTransaction | null = null;
    if (rawTransaction !== null) {
      const row = object(rawTransaction);
      if (!Array.isArray(row.transaction) || row.transaction[1] !== "base64") throw new Error("RPC transaction bytes unavailable");
      const bytes = base64(row.transaction[0]);
      const decoded = getTransactionDecoder().decode(bytes);
      const message = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
      const meta = row.meta === null ? null : object(row.meta);
      if (meta && !("err" in meta)) throw new Error("Receipt status unavailable");
      const loaded = meta?.loadedAddresses === undefined ? { writable: [], readonly: [] } : object(meta.loadedAddresses);
      if (!Array.isArray(loaded.writable) || !Array.isArray(loaded.readonly) || [...loaded.writable, ...loaded.readonly].some(key => typeof key !== "string")) throw new Error("Lookup addresses unavailable");
      const signatures = Object.values(decoded.signatures).map(signature => {
        if (!signature) throw new Error("Confirmed transaction signature missing");
        return getBase58Decoder().decode(signature);
      });
      transaction = { signatures, messageSha256: await messageDigest(bytes), accountKeys: [...message.staticAccounts, ...loaded.writable, ...loaded.readonly], slot: integerString(row.slot),
        meta: meta === null ? null : { err: meta.err, preTokenBalances: meta.preTokenBalances as RawTokenBalance[] | undefined, postTokenBalances: meta.postTokenBalances as RawTokenBalance[] | undefined } };
    }
    return reconcileSolanaSignature({ signature: input.signature, expectedGenesisHash: input.genesisHash, observedGenesisHash: genesis,
      expectedMessageSha256: input.expectedMessageSha256, signatureStatus: status as { confirmationStatus: "processed" | "confirmed" | "finalized" | null; err: unknown | null } | null,
      transaction, expectedDeltas: input.expectedDeltas });
  } catch { return { status: "unknown" as const, reason: "rpc-evidence-unavailable" }; }
}
