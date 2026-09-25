import { deriveEscrowAddresses } from '../finance/solana/index.ts';
import type { Agreement } from './agreements.ts';
import type { requireWalletRecovery } from './recovery.ts';
import {
  createSolanaInitializationService,
  leaseIdForAgreement,
  RpcInitializationGateway,
} from './solana-initialization.ts';
import { RpcSolanaGateway, solanaConfiguration, type SolanaConfiguration } from './solana-rpc.ts';
import { configuredFeeSponsor, createSolanaService, SolanaServiceError } from './solana-service.ts';
import type { Store } from './store.ts';

/**
 * The environment pins one reviewed deployment (program, code hash, reserve, sponsor ceiling).
 * Each accepted agreement gets its own tenancy PDA inside that deployment, derived from the
 * agreement ID and its tenant wallet, so no per-tenancy environment edit is needed.
 */
export async function solanaConfigurationFor(
  store: Store,
  agreementId: string | null,
  environment: Record<string, string | undefined> = process.env,
): Promise<SolanaConfiguration | null> {
  const base = solanaConfiguration(environment);
  if (!base || !agreementId || agreementId === base.agreementId) return base;
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(agreementId))
    throw new SolanaServiceError(400, 'invalid_agreement', 'Choose a valid tenancy.');
  const agreement = await store.get<Agreement>(`agreement:${agreementId}`);
  const tenant = agreement?.parties.tenant?.wallet;
  if (!agreement || agreement.network !== 'solana' || tenant?.chainType !== 'solana')
    throw new SolanaServiceError(404, 'agreement_unavailable', 'A Solana tenancy with a tenant is required.');
  const tenancyAddress = (
    await deriveEscrowAddresses(base.escrowProgram, tenant.address, leaseIdForAgreement(base, agreementId))
  ).tenancy;
  return { ...base, agreementId, tenancyAddress };
}

export async function solanaServicesFor(
  store: Store,
  agreementId: string | null,
  environment: Record<string, string | undefined> = process.env,
  /** Test-signer seam only; production uses the Privy recovery gate. */
  recoveryGate?: typeof requireWalletRecovery,
) {
  const [config, sponsor] = await Promise.all([
    solanaConfigurationFor(store, agreementId, environment),
    configuredFeeSponsor(environment),
  ]);
  if (!config || !sponsor) return null;
  return {
    config,
    service: createSolanaService({ store, config, gateway: new RpcSolanaGateway(config), sponsor, recoveryGate }),
    initialization: createSolanaInitializationService({
      store,
      config,
      gateway: new RpcInitializationGateway(config),
      sponsor,
      recoveryGate,
    }),
  };
}
