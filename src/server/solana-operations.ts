import { createHash, createPublicKey, randomUUID, verify as verifyEd25519 } from 'node:crypto';
import { address, appendTransactionMessageInstructions, blockhash, compileTransaction, createTransactionMessage, getAddressEncoder, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address, type Instruction } from '@solana/kit';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';
import type { ExpectedTokenDelta } from '../finance/solana/reconcile.ts';
import { SOLANA_MAINNET_MANIFEST } from '../finance/solana/manifest.ts';
import { createBaseSolanaGateway, type SolanaGateway } from './solana-rpc.ts';
import { configuredFeeSponsor, SolanaServiceError, type FeeSponsor } from './solana-service.ts';
import type { Store } from './store.ts';

export type SolanaOperationState = 'prepared' | 'broadcast' | 'confirmed' | 'failed' | 'expired';
export type PreparedSolanaOperation = { id: string; kind: string; walletId: string; feePayer: string; transactionBase64: string; expiresAt: string; review: Record<string, unknown> };
export type SolanaOperationResult = { id: string; state: SolanaOperationState; signature?: string; error?: string };
export type SolanaOperationsGateway = Pick<SolanaGateway, 'lifetime' | 'simulate' | 'broadcast' | 'reconcile'>;
export type SponsorshipLimits = { subjectRollingLamports: bigint; subjectRollingTransactions: number; globalDailyLamports: bigint };
export const DEFAULT_SPONSORSHIP_LIMITS: SponsorshipLimits = { subjectRollingLamports: 50_000_000n, subjectRollingTransactions: 60, globalDailyLamports: 1_500_000_000n };
export type SolanaOperationsConfig = { cluster: 'devnet' | 'localnet'; genesisHash: string; maximumSponsorLamports: bigint; sponsorshipLimits?: Partial<SponsorshipLimits> };
export type PrepareSolanaInput = { identity: VerifiedIdentity; kind: string; requestId: string; actor: Address; walletId: string; instructions: readonly Instruction[]; review: Record<string, unknown>; expectedDeltas?: ExpectedTokenDelta[] };
export type ExecuteSponsorInput = { kind: string; requestId: string; instructions: readonly Instruction[]; review: Record<string, unknown>; expectedDeltas?: ExpectedTokenDelta[]; sponsorshipSubject?: string };
export type SolanaOperations = {
  prepare(input: PrepareSolanaInput): Promise<PreparedSolanaOperation>;
  prepareAsSponsor(input: ExecuteSponsorInput): Promise<PreparedSolanaOperation>;
  submit(input: { identity: VerifiedIdentity; id: string; signedTransactionBase64: string }): Promise<SolanaOperationResult & { signature: string }>;
  executeAsSponsor(input: ExecuteSponsorInput): Promise<SolanaOperationResult & { signature: string }>;
  reconcile(input: { identity?: VerifiedIdentity; id: string }): Promise<SolanaOperationResult>;
  cancel(input: { identity: VerifiedIdentity; id: string }): Promise<SolanaOperationResult>;
  get(id: string, identity?: VerifiedIdentity): Promise<PreparedSolanaOperation & SolanaOperationResult>;
};
type RecordOperation = PreparedSolanaOperation & { subject: string; sponsorshipSubject?: string | null; actor: string; fingerprint: string; messageSha256: string; lastValidBlockHeight: string; expectedDeltas: ExpectedTokenDelta[]; state: SolanaOperationState; signature?: string; signedTransactionBase64?: string; error?: string };
type SponsorshipReservation = { amountLamports: string; subject: string | null; reservedAt: number; chargedAt?: number; state: 'reserved' | 'charged'; ownerToken: string };
type SponsorshipLedger = { reservations: Record<string, SponsorshipReservation> };
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
const key = (id: string) => `solana-operation:${id}`;
function fail(message: string, code = 'invalid_operation', status = 409): never { throw new SolanaServiceError(status, code, message); }
function signingKey(wallet: string) {
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(getAddressEncoder().encode(address(wallet)))]), format: 'der', type: 'spki' });
}
function publicPrepared(op: RecordOperation): PreparedSolanaOperation {
  return { id: op.id, kind: op.kind, walletId: op.walletId, feePayer: op.feePayer, transactionBase64: op.transactionBase64, expiresAt: op.expiresAt, review: op.review };
}
function result(op: RecordOperation): SolanaOperationResult { return { id: op.id, state: op.state, ...(op.signature ? { signature: op.signature } : {}), ...(op.error ? { error: op.error } : {}) }; }

/** Env overrides may be zero to deliberately pause free sponsorship. */
export function sponsorshipLimitsFromEnvironment(environment: Record<string, string | undefined>, fallback: SponsorshipLimits = DEFAULT_SPONSORSHIP_LIMITS): SponsorshipLimits {
  const lamports = (name: string, defaultValue: bigint) => {
    const value = environment[name];
    if (value === undefined) return defaultValue;
    if (!/^\d{1,20}$/.test(value) || BigInt(value) > (1n << 64n) - 1n) fail(`Invalid ${name} sponsorship limit.`, 'sponsor_configuration', 503);
    return BigInt(value);
  };
  const count = environment.SOLANA_SPONSOR_SUBJECT_ROLLING_TRANSACTIONS;
  if (count !== undefined && (!/^\d{1,6}$/.test(count) || !Number.isSafeInteger(Number(count)))) fail('Invalid sponsorship transaction-count limit.', 'sponsor_configuration', 503);
  return {
    subjectRollingLamports: lamports('SOLANA_SPONSOR_SUBJECT_ROLLING_LAMPORTS', fallback.subjectRollingLamports),
    subjectRollingTransactions: count === undefined ? fallback.subjectRollingTransactions : Number(count),
    globalDailyLamports: lamports('SOLANA_SPONSOR_GLOBAL_DAILY_LAMPORTS', fallback.globalDailyLamports),
  };
}

/** Exact-message, durable sponsorship shared by house, rent, AI and share actions. */
export function createSolanaOperations(deps: { store: Store; gateway: SolanaOperationsGateway; sponsor: FeeSponsor; config: SolanaOperationsConfig; now?: () => number }): SolanaOperations {
  const { store, gateway, sponsor, config } = deps, now = deps.now ?? Date.now;
  if (!['devnet', 'localnet'].includes(config.cluster) || config.genesisHash === SOLANA_MAINNET_MANIFEST.genesisHash || !config.genesisHash || config.maximumSponsorLamports <= 0n || config.maximumSponsorLamports > 10_000_000n) fail('Only capped test-network sponsorship is supported.');
  const sponsorAddress = address(sponsor.address);
  const network = `${config.cluster}:${config.genesisHash}:${sponsorAddress}`;
  const limits: SponsorshipLimits = { ...DEFAULT_SPONSORSHIP_LIMITS, ...config.sponsorshipLimits };
  if (typeof limits.subjectRollingLamports !== 'bigint' || typeof limits.globalDailyLamports !== 'bigint' || limits.subjectRollingLamports < 0n || limits.globalDailyLamports < 0n || !Number.isSafeInteger(limits.subjectRollingTransactions) || limits.subjectRollingTransactions < 0) fail('Invalid sponsorship ledger limits.', 'sponsor_configuration', 503);
  const ledgerKey = `solana-sponsorship:${sha(network)}`;
  async function ensureLedger() {
    if (await store.get<SponsorshipLedger>(ledgerKey)) return;
    try { await store.create<SponsorshipLedger>(ledgerKey, { reservations: {} }); } catch (error) { if (!await store.get(ledgerKey)) throw error; }
  }
  async function reserveBudget(op: RecordOperation, amount: bigint, token: string, resize = false): Promise<boolean> {
    await ensureLedger();
    let acquired = false;
    await store.update<SponsorshipLedger>(ledgerKey, current => {
      const timestamp = now(), today = new Date(timestamp).toISOString().slice(0, 10), rollingStart = timestamp - 86_400_000;
      const reservations = { ...current.reservations };
      for (const [id, entry] of Object.entries(reservations)) {
        if (entry.state === 'charged' && entry.chargedAt! <= rollingStart && new Date(entry.chargedAt!).toISOString().slice(0, 10) !== today) delete reservations[id];
      }
      const existing = reservations[op.id];
      if (resize && (!existing || existing.state !== 'reserved' || existing.ownerToken !== token)) fail('Sponsorship reservation changed; do not broadcast.', 'sponsor_reservation');
      if (!resize && existing) return { reservations };
      const subject = op.sponsorshipSubject === undefined ? op.subject === 'server:sponsor' ? null : op.subject : op.sponsorshipSubject;
      const ceiling = existing && BigInt(existing.amountLamports) > amount ? BigInt(existing.amountLamports) : amount;
      let subjectLamports = 0n, subjectTransactions = 0, globalLamports = 0n;
      for (const [id, entry] of Object.entries(reservations)) {
        if (id === op.id) continue;
        const value = BigInt(entry.amountLamports);
        // Ambiguous reservations carry across both the rolling window and UTC midnight.
        if (entry.state === 'reserved' || new Date(entry.chargedAt!).toISOString().slice(0, 10) === today || entry.chargedAt! > timestamp) globalLamports += value;
        if (subject !== null && entry.subject === subject && (entry.state === 'reserved' || entry.chargedAt! > rollingStart)) { subjectLamports += value; subjectTransactions++; }
      }
      if (subject !== null && (subjectLamports + ceiling > limits.subjectRollingLamports || subjectTransactions + 1 > limits.subjectRollingTransactions))
        fail("This account has used today's free network fees. Try again tomorrow.", 'sponsor_subject_budget', 429);
      if (globalLamports + ceiling > limits.globalDailyLamports)
        fail("The site's daily network-fee budget is used up. Try again tomorrow.", 'sponsor_global_budget', 429);
      reservations[op.id] = { amountLamports: ceiling.toString(), subject, reservedAt: existing?.reservedAt ?? timestamp, state: 'reserved', ownerToken: token };
      acquired = true;
      return { reservations };
    });
    return acquired;
  }
  async function releaseBudget(op: RecordOperation, ownerToken?: string) {
    if (op.signature && op.state !== 'expired') return;
    const existing = (await store.get<SponsorshipLedger>(ledgerKey))?.reservations[op.id];
    if (!existing || existing.state === 'charged' || (ownerToken !== undefined && existing.ownerToken !== ownerToken)) return;
    await store.update<SponsorshipLedger>(ledgerKey, current => {
      const entry = current.reservations[op.id];
      if (!entry || entry.state === 'charged' || (ownerToken !== undefined && entry.ownerToken !== ownerToken)) return current;
      const reservations = { ...current.reservations };
      delete reservations[op.id];
      return { reservations };
    });
  }
  async function settleBudget(op: RecordOperation) {
    if (op.state === 'expired') { await releaseBudget(op); return; }
    if (op.state !== 'confirmed' && op.state !== 'failed') return;
    const existing = (await store.get<SponsorshipLedger>(ledgerKey))?.reservations[op.id];
    if (!existing || existing.state === 'charged') return;
    await store.update<SponsorshipLedger>(ledgerKey, current => {
      const entry = current.reservations[op.id];
      if (!entry || entry.state === 'charged') return current;
      // Failed landed transactions also cost fees. Only proven absence permits release.
      return { reservations: { ...current.reservations, [op.id]: { ...entry, state: 'charged', chargedAt: now(), ownerToken: '' } } };
    });
  }
  async function load(id: string, identity?: VerifiedIdentity) {
    const op = await store.get<RecordOperation>(key(id));
    if (!op || (identity && (op.subject !== identity.subject || !identity.wallets.some(wallet => wallet.chainType === 'solana' && wallet.id === op.walletId && wallet.address === op.actor)))) fail('Operation is not available to this wallet.', 'operation_owner');
    if (op.feePayer !== sponsorAddress || !op.fingerprint.startsWith(`${network}:`)) fail('The reviewed network or sponsor changed.');
    return op;
  }
  async function simulate(bytes: Uint8Array, actor: string, expectedDeltas?: readonly ExpectedTokenDelta[]) {
    const observation = await gateway.simulate(bytes, sponsorAddress, actor, expectedDeltas);
    const ceiling = BigInt(observation.sponsorDebitCeilingLamports);
    if (ceiling < 0n || ceiling > config.maximumSponsorLamports) fail('Sponsor fee and account-rent ceiling exceeded.', 'sponsor_limit');
    return ceiling;
  }
  async function prepareInternal(input: Omit<PrepareSolanaInput, 'identity'> & { subject: string; sponsorshipSubject: string | null }) {
    if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(input.kind) || !/^[a-zA-Z0-9:_-]{1,200}$/.test(input.requestId) || !input.instructions.length) fail('Invalid operation intent.');
    const id = sha(json([network, input.subject, input.kind, input.requestId]));
    const fingerprint = `${network}:${sha(json([input.actor, input.walletId, input.instructions, input.review, input.expectedDeltas ?? [], input.sponsorshipSubject]))}`;
    const existing = await store.get<RecordOperation>(key(id));
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('This request ID already reviews a different action.');
      return publicPrepared(existing);
    }
    const lifetime = await gateway.lifetime();
    const message = pipe(createTransactionMessage({ version: 0 }), msg => setTransactionMessageFeePayer(sponsorAddress, msg), msg => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(lifetime.blockhash), lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) }, msg), msg => appendTransactionMessageInstructions(input.instructions, msg));
    const compiled = compileTransaction(message);
    const decoded = getCompiledTransactionMessageDecoder().decode(compiled.messageBytes);
    const signers = decoded.staticAccounts.slice(0, decoded.header.numSignerAccounts);
    if (decoded.staticAccounts[0] !== sponsorAddress || signers.length !== (input.actor === sponsorAddress ? 1 : 2) || !signers.includes(input.actor)) fail('Only the sponsor and reviewed wallet may sign.');
    const bytes = new Uint8Array(getTransactionEncoder().encode(compiled));
    await simulate(bytes, input.actor, input.expectedDeltas);
    const op: RecordOperation = { id, kind: input.kind, walletId: input.walletId, feePayer: sponsorAddress, transactionBase64: Buffer.from(bytes).toString('base64'), expiresAt: new Date(now() + 120_000).toISOString(), review: input.review, subject: input.subject, sponsorshipSubject: input.sponsorshipSubject, actor: input.actor, fingerprint, messageSha256: sha(new Uint8Array(compiled.messageBytes)), lastValidBlockHeight: lifetime.lastValidBlockHeight, expectedDeltas: input.expectedDeltas ?? [], state: 'prepared' };
    try { await store.create(key(id), op); } catch (error) {
      const concurrent = await store.get<RecordOperation>(key(id));
      if (!concurrent) throw error;
      if (concurrent.fingerprint !== fingerprint) fail('Concurrent request reviews a different action.');
      return publicPrepared(concurrent);
    }
    return publicPrepared(op);
  }
  async function reconcile(input: { identity?: VerifiedIdentity; id: string }): Promise<SolanaOperationResult> {
    let op = await load(input.id, input.identity);
    if (op.state === 'prepared') {
      if (now() >= Date.parse(op.expiresAt)) op = await store.update<RecordOperation>(key(op.id), current => current.state === 'prepared' ? { ...current, state: 'expired' } : current);
      await settleBudget(op);
      return result(op);
    }
    if (op.state !== 'broadcast' || !op.signature || !op.signedTransactionBase64) { await settleBudget(op); return result(op); }
    try {
      let observation = await gateway.reconcile(op.signature, op.messageSha256, op.expectedDeltas);
      if (observation.status === 'unknown') {
        const lifetime = await gateway.lifetime(); // Existing gateway reports finalized height.
        if (BigInt(lifetime.blockHeight) > BigInt(op.lastValidBlockHeight)) {
          observation = await gateway.reconcile(op.signature, op.messageSha256, op.expectedDeltas);
          if (observation.status === 'unknown' && observation.reason === 'signature-not-observed-do-not-resubmit-new-intent') {
            op = await store.update<RecordOperation>(key(op.id), current => current.state === 'broadcast' ? { ...current, state: 'expired', error: 'The finalized block height passed the transaction lifetime and a fresh lookup found no signature.' } : current);
            await settleBudget(op);
            return result(op);
          }
        } else if (observation.reason === 'signature-not-observed-do-not-resubmit-new-intent') {
          // Upgrade safety: already signed operations created before the ledger still reserve
          // a budget before their first rebroadcast under this service.
          await ensureLedger();
          if (!(await store.get<SponsorshipLedger>(ledgerKey))!.reservations[op.id]) {
            const bytes = new Uint8Array(Buffer.from(op.signedTransactionBase64, 'base64'));
            await reserveBudget(op, await simulate(bytes, op.actor, op.expectedDeltas), randomUUID());
          }
          const returned = await gateway.broadcast(new Uint8Array(Buffer.from(op.signedTransactionBase64, 'base64')));
          if (returned !== op.signature) fail('Broadcast signature differs from persisted bytes.');
        }
      }
      if (observation.status === 'finalized' || observation.status === 'failed') {
        const receipt = observation;
        op = await store.update<RecordOperation>(key(op.id), current => current.state === 'broadcast'
          ? { ...current, state: receipt.status === 'finalized' ? 'confirmed' : ['transaction-error', 'receipt-error'].includes(receipt.reason) ? 'failed' : 'broadcast', ...(receipt.status === 'failed' ? { error: receipt.reason } : {}) }
          : current);
      }
    } catch (error) {
      if (error instanceof SolanaServiceError && ['sponsor_subject_budget', 'sponsor_global_budget'].includes(error.code)) return { ...result(op), error: error.message };
      // Ambiguous RPC errors retain the immutable signed operation and its budget.
    }
    await settleBudget(op);
    return result(op);
  }
  async function signAndBroadcast(op: RecordOperation, bytes: Uint8Array): Promise<SolanaOperationResult & { signature: string }> {
    const ceiling = await simulate(bytes, op.actor, op.expectedDeltas), token = randomUUID();
    if (!await reserveBudget(op, ceiling, token)) {
      const existing = await load(op.id);
      if (existing.signature) return { ...await reconcile({ id: op.id }), signature: existing.signature };
      fail('Another request is sponsoring this operation. Retry checking its existing review.', 'operation_pending');
    }
    try {
      const signedBytes = await sponsor.sign(bytes), signed = getTransactionDecoder().decode(signedBytes), original = getTransactionDecoder().decode(bytes);
      if (sha(new Uint8Array(signed.messageBytes)) !== op.messageSha256) fail('Sponsor changed the approved message.');
      const payerSignature = signed.signatures[sponsorAddress];
      if (!payerSignature || !verifyEd25519(null, Buffer.from(signed.messageBytes), signingKey(sponsorAddress), Buffer.from(payerSignature))) fail('Sponsor signature is invalid.');
      if (op.actor !== sponsorAddress && !Buffer.from(signed.signatures[address(op.actor)] ?? []).equals(Buffer.from(original.signatures[address(op.actor)] ?? []))) fail('Sponsor changed the wallet signature.');
      await reserveBudget(op, await simulate(signedBytes, op.actor, op.expectedDeltas), token, true);
      const signature = getBase58Decoder().decode(payerSignature), encoded = Buffer.from(signedBytes).toString('base64');
      const persisted = await store.update<RecordOperation>(key(op.id), current => {
        if (current.state !== 'prepared') {
          if (current.signature === signature && current.signedTransactionBase64 === encoded) return current;
          fail('Operation already has an immutable signed transaction.');
        }
        return { ...current, state: 'broadcast', signature, signedTransactionBase64: encoded };
      });
      if (persisted.state === 'broadcast') {
        try { if (await gateway.broadcast(signedBytes) !== signature) fail('Broadcast signature mismatch.'); } catch { /* The persisted bytes and reservation remain immutable. */ }
      }
      return { ...await reconcile({ id: op.id }), signature };
    } catch (error) {
      // This service never broadcasts before the durable signed-write. A failed signing/
      // signed-write attempt with no persisted signature is provably not sent. A cancelled
      // review also cannot pass the atomic signed-write, even if signing was in flight.
      const current = await load(op.id);
      if (!current.signature || current.state === 'expired') await releaseBudget(current, token);
      throw error;
    }
  }
  async function prepareAsSponsor(input: ExecuteSponsorInput): Promise<PreparedSolanaOperation> {
    if (input.sponsorshipSubject !== undefined && (typeof input.sponsorshipSubject !== 'string' || !input.sponsorshipSubject || input.sponsorshipSubject.length > 512)) fail('Invalid server sponsorship subject.');
    return prepareInternal({ ...input, subject: 'server:sponsor', sponsorshipSubject: input.sponsorshipSubject ?? null, actor: sponsorAddress, walletId: 'sponsor' });
  }
  return {
    cancel: async (input: { identity: VerifiedIdentity; id: string }) => {
      const op = await load(input.id, input.identity);
      const cancelled = await store.update<RecordOperation>(key(op.id), current => {
        if (current.state === 'expired' && !current.signature) return current;
        if (current.state !== 'prepared') fail('A signed transaction cannot be cancelled.');
        return { ...current, state: 'expired', error: 'Unsigned review cancelled.' };
      });
      await releaseBudget(cancelled);
      return result(cancelled);
    },
    prepare: async (input: PrepareSolanaInput) => {
      if (!input.identity.wallets.some(wallet => wallet.chainType === 'solana' && wallet.id === input.walletId && wallet.address === input.actor) || input.actor === sponsorAddress) fail('Use your own signed-in Solana wallet.', 'operation_owner');
      return prepareInternal({ ...input, subject: input.identity.subject, sponsorshipSubject: input.identity.subject });
    },
    submit: async (input: { identity: VerifiedIdentity; id: string; signedTransactionBase64: string }): Promise<SolanaOperationResult & { signature: string }> => {
      const op = await load(input.id, input.identity);
      if (op.state !== 'prepared') { const next = await reconcile(input); if (!next.signature) fail('This review expired; prepare a new request ID.'); return { ...next, signature: next.signature }; }
      if (now() >= Date.parse(op.expiresAt) || BigInt((await gateway.lifetime()).blockHeight) >= BigInt(op.lastValidBlockHeight)) fail('This review expired; prepare a fresh review.');
      if (typeof input.signedTransactionBase64 !== 'string' || input.signedTransactionBase64.length > 1644) fail('Invalid signed transaction encoding.');
      const bytes = Buffer.from(input.signedTransactionBase64, 'base64');
      if (bytes.length > 1232 || bytes.toString('base64') !== input.signedTransactionBase64) fail('Invalid signed transaction encoding.');
      const signed = getTransactionDecoder().decode(bytes), actorSignature = signed.signatures[address(op.actor)], payerSignature = signed.signatures[sponsorAddress];
      if (sha(new Uint8Array(signed.messageBytes)) !== op.messageSha256 || Object.keys(signed.signatures).length !== 2) fail('Signed bytes differ from the exact review.');
      if (!actorSignature || !verifyEd25519(null, Buffer.from(signed.messageBytes), signingKey(op.actor), Buffer.from(actorSignature))) fail('The reviewed wallet signature is invalid.');
      if (payerSignature?.some(byte => byte !== 0)) fail('Do not submit a sponsor signature.');
      return signAndBroadcast(op, new Uint8Array(bytes));
    },
    executeAsSponsor: async (input: ExecuteSponsorInput): Promise<SolanaOperationResult & { signature: string }> => {
      const prepared = await prepareAsSponsor(input);
      const op = await load(prepared.id);
      if (op.state !== 'prepared') { const next = await reconcile({ id: op.id }); if (!next.signature) fail('Server operation expired; use a fresh request ID.'); return { ...next, signature: next.signature }; }
      if (now() >= Date.parse(op.expiresAt) || BigInt((await gateway.lifetime()).blockHeight) >= BigInt(op.lastValidBlockHeight)) fail('Server operation lifetime expired.');
      return signAndBroadcast(op, new Uint8Array(Buffer.from(op.transactionBase64, 'base64')));
    },
    prepareAsSponsor,
    reconcile,
    get: async (id: string, identity?: VerifiedIdentity) => { const op = await load(id, identity); return { ...publicPrepared(op), ...result(op) }; },
  };
}

/** Uses only the existing gateway's network/simulation/receipt methods, not its escrow snapshot. */
export async function configuredSolanaOperations(store: Store, config: SolanaOperationsConfig, environment: Record<string, string | undefined> = process.env) {
  const sponsor = await configuredFeeSponsor(environment);
  if (!sponsor || !environment.SOLANA_RPC_URL) fail('Solana fee sponsorship is not configured.');
  const url = new URL(environment.SOLANA_RPC_URL!);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('RPC must use HTTPS or loopback.');
  const gateway = createBaseSolanaGateway({ rpcUrl: url.toString(), genesisHash: config.genesisHash, maximumSponsorLamports: config.maximumSponsorLamports.toString() });
  const sponsorshipLimits = sponsorshipLimitsFromEnvironment(environment, { ...DEFAULT_SPONSORSHIP_LIMITS, ...config.sponsorshipLimits });
  return { operations: createSolanaOperations({ store, gateway, sponsor: sponsor!, config: { ...config, sponsorshipLimits } }), gateway, sponsor: sponsor! };
}
