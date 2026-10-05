import { createHash, createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type SignatureBytes,
} from '@solana/kit';
import {
  atomic,
  buildInitializeEscrow,
  decodeClassicTokenAccount,
  derivePayoutAddress,
  deriveEscrowAddresses,
  ledgerDepositMint,
  messageDigest,
  SOLANA_IDS,
  validateKaminoAccounts,
  validateMintObservation,
  type AccountObservation,
} from '../finance/solana/index.ts';
import { agreementDigest, agreementRole, type Agreement } from './agreements.ts';
import { requireWalletAccess, type WalletAccessGate } from './wallet-access.ts';
import {
  RpcSolanaGateway,
  solanaConfiguration,
  verifyDeployedProgram,
  type SolanaConfiguration,
  type SolanaGateway,
  type SolanaSimulation,
} from './solana-rpc.ts';
import { configuredFeeSponsor, SolanaServiceError, type FeeSponsor } from './solana-service.ts';
import type { Store } from './store.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const key = (wallet: string) =>
  createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(getAddressEncoder().encode(address(wallet))),
    ]),
    format: 'der',
    type: 'spki',
  });
function fail(code: string, message: string, status = 409): never {
  throw new SolanaServiceError(status, code, message);
}
export function leaseIdForAgreement(config: SolanaConfiguration, agreementId: string) {
  return new Uint8Array(
    createHash('sha256')
      .update(`rental-lease-v1:solana:${config.genesisHash}:${config.escrowProgram}:${agreementId}`)
      .digest(),
  );
}
export async function payoutTokenAccount(config: SolanaConfiguration, owner: string) {
  return derivePayoutAddress(owner, ledgerDepositMint(config));
}

type PartyRole = 'tenant' | 'landlord';
type InitState = 'prepared' | 'signed' | 'broadcast' | 'unknown' | 'finalized' | 'failed';
export type SolanaInitialization = {
  setupMode: 'joint' | 'staged';
  agreementId: string;
  tenancyAddress: string;
  policyHash: string;
  leaseIdHex: string;
  tenantDestination: string;
  landlordDestination: string;
  tenant: string;
  landlord: string;
  arbitrator: string;
  requiredSecurityAtomic: string;
  depositMint?: string;
  releasePermitted: boolean;
  state: InitState;
  transactionBase64: string;
  messageSha256: string;
  expiresAt: string;
  lastValidBlockHeight: string;
  signatures: Partial<Record<PartyRole, string>>;
  signedTxBase64: string | null;
  signature: string | null;
  simulation: SolanaSimulation;
  lastError: string | null;
  receipt: unknown | null;
};
export type SolanaInitializationView = Omit<SolanaInitialization, 'signatures' | 'signedTxBase64'> & {
  signedRoles: PartyRole[];
  role: 'tenant' | 'landlord' | 'arbitrator';
  walletId: string;
  feePayer: string;
  depositMint: string;
  cluster: 'devnet' | 'localnet';
  walletChain: 'solana:devnet' | null;
  escrowProgram: string;
};
export type InitializationGateway = Pick<
  SolanaGateway,
  'lifetime' | 'simulate' | 'broadcast' | 'reconcile' | 'snapshot'
> & {
  preflight(input: {
    tenant: string;
    landlord: string;
    tenantDestination: string;
    landlordDestination: string;
    tenancyAddress: string;
    cashAddress: string;
    receiptAddress: string;
  }): Promise<void>;
};

export class RpcInitializationGateway extends RpcSolanaGateway implements InitializationGateway {
  async preflight(input: Parameters<InitializationGateway['preflight']>[0]) {
    const config = this.config;
    const genesisHash = await this.checkedGenesis();
    const keys = [
      config.escrowProgram,
      input.tenancyAddress,
      input.cashAddress,
      input.receiptAddress,
      config.reserve,
      config.market,
      config.liquiditySupply,
      SOLANA_IDS.klend,
      ledgerDepositMint(config),
      config.receiptMint,
      input.tenantDestination,
      input.landlordDestination,
      ...config.oracleAccounts,
    ];
    const observed = await this.multiple(keys);
    const rows = observed.accounts;
    const program = rows[0];
    if (!program) throw new Error('Escrow program is unavailable');
    let programData: AccountObservation | undefined;
    if (program.data.length === 36 && program.owner === 'BPFLoaderUpgradeab1e11111111111111111111111') {
      const dataAddress = getAddressDecoder().decode(program.data.subarray(4, 36));
      programData = (await this.multiple([dataAddress])).accounts[0] ?? undefined;
    }
    verifyDeployedProgram(config, program, programData);
    if (rows[1] || rows[2] || rows[3])
      fail('tenancy_exists', 'The configured tenancy or escrow token accounts already exist.');
    if (!rows[10] || !rows[11])
      fail('payout_accounts_missing', 'Create both fixed test-USDC payout accounts before initialization.');
    if (rows.slice(4).some((row) => !row))
      fail('setup_accounts_missing', 'The reviewed reserve, mint or oracle account is missing.');
    const ready = rows.slice(4) as (AccountObservation & { lamports: string })[];
    if (ready[4].data.length !== 82)
      throw new Error('Unreviewed test-USDC mint layout');
    validateMintObservation(
      {
        address: ready[4].address,
        owner: ready[4].owner,
        decimals: ready[4].data[44],
        initialized: ready[4].data[45] === 1,
        supplyAtomic: new DataView(ready[4].data.buffer, ready[4].data.byteOffset)
          .getBigUint64(36, true)
          .toString(),
      },
      { mint: ledgerDepositMint(config), tokenProgram: SOLANA_IDS.token, decimals: 6 },
    );
    if (ready[5].data.length !== 82)
      throw new Error('Unreviewed lending receipt mint layout');
    validateMintObservation(
      {
        address: ready[5].address,
        owner: ready[5].owner,
        decimals: ready[5].data[44],
        initialized: ready[5].data[45] === 1,
        supplyAtomic: new DataView(ready[5].data.buffer, ready[5].data.byteOffset)
          .getBigUint64(36, true)
          .toString(),
      },
      { mint: config.receiptMint, tokenProgram: SOLANA_IDS.token, decimals: 6 },
    );
    if (getAddressDecoder().decode(ready[5].data.subarray(4, 36)) !== config.marketAuthority)
      throw new Error('Wrong lending receipt mint authority');
    await validateKaminoAccounts({
      manifest: config,
      context: { genesisHash, slot: observed.slot, observedAtMs: Date.now() },
      nowMs: Date.now(),
      reserve: ready[0],
      market: ready[1],
      liquiditySupply: ready[2],
      program: ready[3],
      trackedReceiptAtomic: '0',
    });
    for (const [row, owner] of [
      [ready[6], input.tenant],
      [ready[7], input.landlord],
    ] as const) {
      const account = decodeClassicTokenAccount(row);
      if (
        account.authority !== owner ||
        account.mint !== ledgerDepositMint(config) ||
        !account.initialized ||
        account.frozen
      )
        fail('wrong_payout_account', 'A fixed USDC payout account differs from its party.');
    }
  }
}

export function createSolanaInitializationService(input: {
  store: Store;
  config: SolanaConfiguration;
  gateway: InitializationGateway;
  sponsor: FeeSponsor;
  now?: () => number;
  accessGate?: WalletAccessGate;
}) {
  const { store, config, gateway, sponsor } = input;
  const now = input.now ?? Date.now;
  const walletAccess = input.accessGate ?? requireWalletAccess;
  const requiredRoles: PartyRole[] = config.setupMode === 'staged' ? ['landlord'] : ['tenant', 'landlord'];
  const recordKey = `solana-initialization:${hash(`${config.genesisHash}:${config.tenancyAddress}`)}`;
  async function access(identity: VerifiedIdentity, signing = false) {
    const agreement = await store.get<Agreement>(`agreement:${config.agreementId}`);
    if (!agreement || agreement.network !== 'solana')
      fail('agreement_unavailable', 'A complete Solana agreement is required.', 403);
    const role = agreementRole(agreement, identity);
    const party = agreement.parties[role]!;
    if (signing && agreement.cancelled)
      fail('agreement_cancelled', 'This tenancy was cancelled before the deposit was secured.');
    if (identity.expiresAt * 1000 <= now() || party.wallet.chainType !== 'solana')
      fail('identity_expired', 'Sign in again before authorizing this tenancy.', 401);
    if (signing && !requiredRoles.includes(role as PartyRole))
      fail('signer_required', config.setupMode === 'staged'
        ? 'Only the landlord creates this empty escrow; the tenant signs funding later.'
        : 'The tenant and landlord initialize this tenancy.', 403);
    if (signing) await walletAccess(store, identity, party.wallet.id);
    const digest = agreementDigest(agreement);
    if (
      !digest ||
      agreement.accepted.tenant?.digest !== digest ||
      agreement.accepted.landlord?.digest !== digest
    )
      fail('agreement_not_accepted', 'Tenant and landlord must accept the same complete agreement.');
    const tenant = agreement.parties.tenant!.wallet.address;
    const landlord = agreement.parties.landlord!.wallet.address;
    const arbitrator = agreement.parties.arbitrator!.wallet.address;
    if (new Set([tenant, landlord, arbitrator, sponsor.address]).size !== 4)
      fail('invalid_sponsor', 'The fee sponsor must be separate from all parties.');
    const leaseId = leaseIdForAgreement(config, agreement.id);
    const derived = await deriveEscrowAddresses(config.escrowProgram, tenant, leaseId);
    if (derived.tenancy !== config.tenancyAddress)
      fail('wrong_tenancy', 'The configured tenancy does not match the accepted agreement.');
    const [tenantDestination, landlordDestination] = await Promise.all([
      payoutTokenAccount(config, tenant),
      payoutTokenAccount(config, landlord),
    ]);
    return {
      agreement,
      role,
      wallet: party.wallet,
      digest,
      leaseId,
      derived,
      tenant,
      landlord,
      arbitrator,
      tenantDestination,
      landlordDestination,
    };
  }
  function publicView(record: SolanaInitialization, verified: Awaited<ReturnType<typeof access>>): SolanaInitializationView {
    const { signatures, signedTxBase64: _, ...visible } = record;
    void _;
    return {
      ...visible,
      setupMode: record.setupMode ?? 'joint',
      depositMint: record.depositMint ?? config.depositMint,
      signedRoles: requiredRoles.filter((role) => Boolean(signatures[role])),
      role: verified.role,
      walletId: verified.wallet.id,
      feePayer: sponsor.address,
      cluster: config.cluster,
      escrowProgram: config.escrowProgram,
      walletChain: config.cluster === 'devnet' ? 'solana:devnet' : null,
    };
  }
  async function existing() {
    const record = await store.get<SolanaInitialization>(recordKey);
    if (record && (record.setupMode ?? 'joint') !== config.setupMode)
      fail('setup_mode_changed', 'The configured setup mode differs from the recorded transaction.');
    return record;
  }
  async function stillLive(record: SolanaInitialization) {
    if (Date.parse(record.expiresAt) <= now()) return false;
    const lifetime = await gateway.lifetime();
    return atomic(lifetime.blockHeight) < atomic(record.lastValidBlockHeight);
  }
  async function preflight(verified: Awaited<ReturnType<typeof access>>) {
    await gateway.preflight({
      tenant: verified.tenant,
      landlord: verified.landlord,
      tenantDestination: verified.tenantDestination,
      landlordDestination: verified.landlordDestination,
      tenancyAddress: config.tenancyAddress,
      cashAddress: verified.derived.cash,
      receiptAddress: verified.derived.receipts,
    });
  }
  async function verifyInitialized(verified: Awaited<ReturnType<typeof access>>) {
    const snapshot = await gateway.snapshot();
    const t = snapshot.tenancy;
    if (
      snapshot.genesisHash !== config.genesisHash ||
      t.address !== config.tenancyAddress ||
      Buffer.from(t.leaseId).toString('hex') !== Buffer.from(verified.leaseId).toString('hex') ||
      Buffer.from(t.policyHash).toString('hex') !== verified.digest.slice(2) ||
      t.tenant !== verified.tenant ||
      t.landlord !== verified.landlord ||
      t.arbitrator !== verified.arbitrator ||
      t.tenantDestination !== await derivePayoutAddress(verified.tenant, t.depositMint) ||
      t.landlordDestination !== await derivePayoutAddress(verified.landlord, t.depositMint) ||
      t.requiredSecurityAtomic !== verified.agreement.requiredSecurity ||
      t.releasePermitted !== verified.agreement.releaseAllowed ||
      !['awaiting-funding', 'active', 'claim-proposed', 'disputed', 'settling', 'closed'].includes(t.phase)
    )
      fail('tenancy_binding_mismatch', 'The initialized tenancy differs from the accepted agreement.');
  }
  async function update(change: (record: SolanaInitialization) => SolanaInitialization) {
    return store.update<SolanaInitialization>(recordKey, change);
  }
  async function reconcileStored(verified: Awaited<ReturnType<typeof access>>) {
    const record = await existing();
    if (!record) fail('initialization_unavailable', 'Prepare initialization first.', 404);
    if (!record.signature || !record.signedTxBase64 || record.state === 'finalized' || record.state === 'failed')
      return record;
    const receipt = await gateway.reconcile(record.signature, record.messageSha256, []);
    let state: InitState = receipt.status === 'finalized' ? 'finalized' : receipt.status === 'failed' ? 'failed' : 'unknown';
    let lastError = receipt.status === 'finalized' ? null : receipt.reason;
    if (state === 'finalized') {
      try {
        await verifyInitialized(verified);
      } catch {
        state = 'unknown';
        lastError = 'Finalized receipt found; awaiting a matching initialized tenancy read.';
      }
    }
    return update((current) =>
      current.state === 'finalized' || current.state === 'failed'
        ? current
        : { ...current, state, receipt, lastError },
    );
  }
  async function sendStored(record: SolanaInitialization) {
    if (!record.signedTxBase64 || !record.signature) throw new Error('Signed initialization missing');
    // Persisted signed setup and this revision checkpoint serialize broadcast against cancel.
    await store.update<Agreement>(`agreement:${config.agreementId}`, (agreement) => {
      if (agreement.cancelled)
        fail('agreement_cancelled', 'This tenancy was cancelled before the deposit was secured.');
      return { ...agreement, revision: agreement.revision + 1 };
    });
    try {
      const sent = await gateway.broadcast(new Uint8Array(Buffer.from(record.signedTxBase64, 'base64')));
      if (sent !== record.signature) throw new Error('RPC returned another signature');
      return update((current) =>
        ['finalized', 'failed'].includes(current.state)
          ? current
          : { ...current, state: 'broadcast', lastError: null },
      );
    } catch {
      return update((current) =>
        ['finalized', 'failed'].includes(current.state)
          ? current
          : {
              ...current,
              state: 'unknown',
              lastError: 'Broadcast outcome is unknown. Reconcile this same signed transaction.',
            },
      );
    }
  }
  return {
    recordKey,
    async status(identity: VerifiedIdentity) {
      const verified = await access(identity);
      const record = await existing();
      return {
        available: true as const,
        agreementId: config.agreementId,
        tenancyAddress: config.tenancyAddress,
        role: verified.role,
        walletId: verified.wallet.id,
        feePayer: sponsor.address,
        cluster: config.cluster,
        setupMode: config.setupMode,
        walletChain: config.cluster === 'devnet' ? ('solana:devnet' as const) : null,
        initialization: record ? publicView(record, verified) : null,
      };
    },
    async prepare(identity: VerifiedIdentity) {
      const verified = await access(identity, true);
      let prior = await existing();
      if (prior && ['signed', 'broadcast', 'unknown'].includes(prior.state)) {
        prior = await reconcileStored(verified);
        const receipt = prior.receipt as { status?: unknown; reason?: unknown } | null;
        const lifetime = await gateway.lifetime();
        if (
          prior.state !== 'unknown' ||
          receipt?.status !== 'unknown' ||
          receipt.reason !== 'signature-not-observed-do-not-resubmit-new-intent' ||
          atomic(lifetime.blockHeight) <= atomic(prior.lastValidBlockHeight)
        ) return publicView(prior, verified);
      }
      if (prior?.state === 'finalized') return publicView(prior, verified);
      if (prior?.state === 'prepared' && (await stillLive(prior)))
        return publicView(prior, verified);
      await preflight(verified);
      const lifetime = await gateway.lifetime();
      if (atomic(lifetime.blockHeight) >= atomic(lifetime.lastValidBlockHeight))
        fail('blockhash_expired', 'Request a fresh blockhash.');
      const instruction = await buildInitializeEscrow({
        manifest: config,
        mode: config.setupMode,
        payer: sponsor.address,
        tenant: verified.tenant,
        landlord: verified.landlord,
        arbitrator: verified.arbitrator,
        leaseId: verified.leaseId,
        policyHash: new Uint8Array(Buffer.from(verified.digest.slice(2), 'hex')),
        releasePermitted: verified.agreement.releaseAllowed,
        requiredSecurityAtomic: verified.agreement.requiredSecurity,
        tenantDestination: verified.tenantDestination,
        landlordDestination: verified.landlordDestination,
      });
      const computeData = new Uint8Array(5);
      computeData[0] = 2;
      new DataView(computeData.buffer).setUint32(1, 600_000, true);
      const baseMessage = setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(lifetime.blockhash),
          lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
        },
        setTransactionMessageFeePayer(address(sponsor.address), createTransactionMessage({ version: 0 })),
      );
      const computeMessage = appendTransactionMessageInstruction(
        { programAddress: address('ComputeBudget111111111111111111111111111111'), data: computeData },
        baseMessage,
      );
      const message = appendTransactionMessageInstruction(instruction, computeMessage);
      const bytes = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
      if (bytes.length > 1232) fail('transaction_too_large', 'Initialization exceeds Solana size limits.');
      const simulation = await gateway.simulate(bytes, sponsor.address, config.setupMode === 'staged' ? verified.landlord : verified.tenant);
      if (atomic(simulation.sponsorDebitCeilingLamports) > atomic(config.maximumSponsorLamports))
        fail('sponsor_limit', 'The initialization rent and fee exceed the configured sponsor limit.');
      const expiresAt =
        now() +
        Math.min(Number(atomic(lifetime.lastValidBlockHeight) - atomic(lifetime.blockHeight)) * 300, 90_000);
      const record: SolanaInitialization = {
        setupMode: config.setupMode,
        agreementId: config.agreementId,
        tenancyAddress: config.tenancyAddress,
        policyHash: verified.digest.slice(2),
        leaseIdHex: Buffer.from(verified.leaseId).toString('hex'),
        tenantDestination: verified.tenantDestination,
        landlordDestination: verified.landlordDestination,
        tenant: verified.tenant,
        landlord: verified.landlord,
        arbitrator: verified.arbitrator,
        requiredSecurityAtomic: verified.agreement.requiredSecurity,
        depositMint: ledgerDepositMint(config),
        releasePermitted: verified.agreement.releaseAllowed,
        state: 'prepared',
        transactionBase64: Buffer.from(bytes).toString('base64'),
        messageSha256: await messageDigest(bytes),
        expiresAt: new Date(expiresAt).toISOString(),
        lastValidBlockHeight: lifetime.lastValidBlockHeight,
        signatures: {},
        signedTxBase64: null,
        signature: null,
        simulation,
        lastError: null,
        receipt: null,
      };
      if (!prior) {
        try {
          await store.create(recordKey, record);
          return publicView(record, verified);
        } catch {
          if (!(await existing())) throw new Error('Initialization storage unavailable');
        }
      }
      const saved = await update((current) => {
        const receipt = current.receipt as { status?: unknown; reason?: unknown } | null;
        const expiredUnobserved =
          current.state === 'unknown' &&
          current.signature === prior?.signature &&
          current.messageSha256 === prior.messageSha256 &&
          receipt?.status === 'unknown' &&
          receipt.reason === 'signature-not-observed-do-not-resubmit-new-intent' &&
          atomic(lifetime.blockHeight) > atomic(current.lastValidBlockHeight);
        if (['signed', 'broadcast', 'unknown', 'finalized'].includes(current.state) && !expiredUnobserved)
          return current;
        if (
          current.state === 'prepared' &&
          Date.parse(current.expiresAt) > now() &&
          atomic(current.lastValidBlockHeight) > atomic(lifetime.blockHeight)
        )
          return current;
        return record;
      });
      return publicView(saved, verified);
    },
    async sign(identity: VerifiedIdentity, signedTxBase64: string) {
      const verified = await access(identity, true);
      const role = verified.role as PartyRole;
      const record = await existing();
      if (!record || record.state !== 'prepared')
        fail('initialization_unavailable', 'Prepare a fresh initialization first.');
      if (typeof signedTxBase64 !== 'string' || signedTxBase64.length > 1800)
        fail('invalid_signature', 'Invalid signed transaction.', 400);
      const raw = Buffer.from(signedTxBase64, 'base64');
      if (raw.toString('base64') !== signedTxBase64 || raw.length > 1232)
        fail('invalid_signature', 'Invalid transaction encoding.', 400);
      const tx = getTransactionDecoder().decode(raw);
      if ((await messageDigest(raw)) !== record.messageSha256)
        fail('changed_message', 'The signed message differs from the accepted initialization.', 400);
      const actor = verified.wallet.address;
      const signature = tx.signatures[address(actor)];
      if (!signature || !verifyEd25519(null, Buffer.from(tx.messageBytes), key(actor), Buffer.from(signature)))
        fail('invalid_signature', 'The party signature did not verify.', 400);
      if (tx.signatures[address(sponsor.address)])
        fail('unexpected_sponsor_signature', 'Only the server adds its fee signature.', 400);
      if (!(await stillLive(record))) fail('blockhash_expired', 'Refresh the initialization and sign again.');
      const stored = await update((current) => {
        if (current.state !== 'prepared' || current.messageSha256 !== record.messageSha256)
          fail('changed_message', 'Initialization changed while it was being signed.');
        const encoded = Buffer.from(signature).toString('base64');
        if (current.signatures[role] && current.signatures[role] !== encoded)
          fail('signature_conflict', 'This party already signed a different transaction.');
        return { ...current, signatures: { ...current.signatures, [role]: encoded } };
      });
      if (!requiredRoles.every((required) => Boolean(stored.signatures[required])))
        return publicView(stored, verified);
      await preflight(verified);
      if (!(await stillLive(stored))) fail('blockhash_expired', 'Refresh the initialization and sign again.');
      const template = getTransactionDecoder().decode(Buffer.from(stored.transactionBase64, 'base64'));
      const partySignatures = requiredRoles.map((required) => ({
        party: verified[required],
        signature: new Uint8Array(Buffer.from(stored.signatures[required]!, 'base64')),
      }));
      const signatures = { ...template.signatures };
      for (const { party, signature } of partySignatures) {
        if (!signature || !verifyEd25519(null, Buffer.from(template.messageBytes), key(party), Buffer.from(signature)))
          fail('invalid_signature', 'The stored party signatures do not verify.');
        signatures[address(party)] = signature as SignatureBytes;
      }
      const partySigned = new Uint8Array(
        getTransactionEncoder().encode({ ...template, signatures }),
      );
      const simulation = await gateway.simulate(partySigned, sponsor.address, config.setupMode === 'staged' ? verified.landlord : verified.tenant);
      if (atomic(simulation.sponsorDebitCeilingLamports) > atomic(config.maximumSponsorLamports))
        fail('sponsor_limit', 'The sponsor rent and fee limit would be exceeded.');
      const complete = await sponsor.sign(partySigned);
      if ((await messageDigest(complete)) !== stored.messageSha256)
        throw new Error('Sponsor changed the accepted initialization message');
      const done = getTransactionDecoder().decode(complete);
      const payerSignature = done.signatures[address(sponsor.address)];
      if (!payerSignature || !verifyEd25519(null, Buffer.from(done.messageBytes), key(sponsor.address), Buffer.from(payerSignature)))
        throw new Error('Sponsor signature did not verify');
      for (const { party, signature } of partySignatures) {
        if (!Buffer.from(done.signatures[address(party)] ?? []).equals(Buffer.from(signature)))
          throw new Error('Sponsor changed a party signature');
      }
      const transactionSignature = getBase58Decoder().decode(payerSignature);
      const completed = await update((current) => {
        if (current.signedTxBase64) return current;
        if (current.state !== 'prepared' || current.messageSha256 !== stored.messageSha256)
          fail('changed_message', 'Initialization changed before broadcast.');
        return {
          ...current,
          state: 'signed',
          signedTxBase64: Buffer.from(complete).toString('base64'),
          signature: transactionSignature,
          simulation,
        };
      });
      return publicView(await sendStored(completed), verified);
    },
    async reconcile(identity: VerifiedIdentity) {
      const verified = await access(identity);
      return publicView(await reconcileStored(verified), verified);
    },
    async retry(identity: VerifiedIdentity) {
      const verified = await access(identity, true);
      let record = await reconcileStored(verified);
      if (record.state === 'finalized' || record.state === 'failed') return publicView(record, verified);
      const receipt = record.receipt as { reason?: unknown; status?: unknown } | null;
      if (
        receipt?.status !== 'unknown' ||
        receipt.reason !== 'signature-not-observed-do-not-resubmit-new-intent' ||
        !record.signedTxBase64 ||
        !(await stillLive(record))
      )
        return publicView(record, verified);
      await preflight(verified);
      record = await sendStored(record);
      return publicView(record, verified);
    },
  };
}

export async function configuredSolanaInitializationService(
  store: Store,
  environment: Record<string, string | undefined> = process.env,
) {
  const config = solanaConfiguration(environment);
  const sponsor = await configuredFeeSponsor(environment);
  if (!config || !sponsor) return null;
  return createSolanaInitializationService({
    store,
    config,
    gateway: new RpcInitializationGateway(config),
    sponsor,
  });
}
