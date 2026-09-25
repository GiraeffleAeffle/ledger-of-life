import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { decodeClassicTokenAccount, deriveEscrowAddresses, SOLANA_IDS } from '../finance/solana/index.ts';
import type { Agreement } from './agreements.ts';
import type { RecoveryGate } from './recovery.ts';
import {
  createSolanaInitializationService,
  leaseIdForAgreement,
  payoutTokenAccount,
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
  recoveryGate?: RecoveryGate,
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

/**
 * The sponsor creates each party's own canonical test-USDC account (the party owns it; the
 * sponsor only pays rent). Idempotent; waits for finality so the setup preflight can see them.
 */
export async function ensurePayoutAccounts(
  store: Store,
  agreementId: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<'ready' | 'created'> {
  const [config, sponsor] = await Promise.all([
    solanaConfigurationFor(store, agreementId, environment),
    configuredFeeSponsor(environment),
  ]);
  if (!config || !sponsor) throw new SolanaServiceError(503, 'solana_unavailable', 'The deposit service is not configured.');
  const agreement = (await store.get<Agreement>(`agreement:${agreementId}`))!;
  const owners = [agreement.parties.tenant?.wallet.address, agreement.parties.landlord?.wallet.address];
  if (owners.some((owner) => !owner) || owners.includes(sponsor.address))
    throw new SolanaServiceError(409, 'parties_missing', 'Tenant and landlord must both be recorded.');
  const gateway = new RpcInitializationGateway(config);
  await gateway.checkedGenesis();
  const destinations = await Promise.all(owners.map((owner) => payoutTokenAccount(config, owner!)));
  const { accounts } = await gateway.multiple(destinations);
  const missing = owners.flatMap((owner, index) => {
    const row = accounts[index];
    if (!row) return [index];
    const token = decodeClassicTokenAccount(row);
    if (token.authority !== owner || token.mint !== config.depositMint || !token.initialized || token.frozen)
      throw new SolanaServiceError(409, 'payout_account_mismatch', 'An existing payout account does not match its party.');
    return [];
  });
  if (!missing.length) return 'ready';
  const lifetime = await gateway.lifetime();
  const message = appendTransactionMessageInstructions(
    missing.map((index) => ({
      programAddress: address(SOLANA_IDS.associatedToken),
      data: Uint8Array.of(1), // CreateIdempotent
      accounts: [
        { address: address(sponsor.address), role: AccountRole.WRITABLE_SIGNER },
        { address: address(destinations[index]), role: AccountRole.WRITABLE },
        { address: address(owners[index]!), role: AccountRole.READONLY },
        { address: address(config.depositMint), role: AccountRole.READONLY },
        { address: address(SOLANA_IDS.system), role: AccountRole.READONLY },
        { address: address(SOLANA_IDS.token), role: AccountRole.READONLY },
      ],
    })),
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(lifetime.blockhash), lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) },
      setTransactionMessageFeePayer(address(sponsor.address), createTransactionMessage({ version: 0 })),
    ),
  );
  const unsigned = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
  await gateway.simulate(unsigned, sponsor.address, sponsor.address);
  const signed = await sponsor.sign(unsigned);
  const signature = getBase58Decoder().decode(getTransactionDecoder().decode(signed).signatures[address(sponsor.address)]!);
  if ((await gateway.broadcast(signed)) !== signature) throw new Error('RPC returned another signature');
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = (await gateway.rpc('getSignatureStatuses', [[signature]])) as { value: ({ err: unknown; confirmationStatus?: string } | null)[] };
    const entry = status.value[0];
    if (entry?.err) throw new SolanaServiceError(502, 'payout_accounts_failed', 'Creating payout accounts failed.');
    if (entry?.confirmationStatus === 'finalized') return 'created';
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, 2000);
    await pause.promise;
  }
  throw new SolanaServiceError(504, 'payout_accounts_pending', 'Payout accounts are still confirming. Try again shortly.');
}
