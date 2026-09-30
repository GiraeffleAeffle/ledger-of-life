import { createHash, randomUUID } from 'node:crypto';
import {
  address, appendTransactionMessageInstructions, blockhash, compileTransaction, createKeyPairSignerFromBytes,
  createNoopSigner, createTransactionMessage, getBase58Decoder, getTransactionDecoder, getTransactionEncoder,
  isSome, partiallySignTransaction, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, type ReadonlyUint8Array,
} from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getMintDecoder, getMintToCheckedInstruction } from '@solana-program/token-2022';
import { SOLANA_IDS, SOLANA_TEST_USDC_MINT, type SignatureReconciliation } from '../finance/solana/index.ts';
import { ConflictError } from './errors.ts';
import { RpcSolanaGateway, solanaConfiguration } from './solana-rpc.ts';
import { configuredFeeSponsor } from './solana-service.ts';
import type { Store } from './store.ts';
const DAY = 86_400_000;
const KEY = 'solana-test-usdc:devnet';
const digest = (bytes: ReadonlyUint8Array) => createHash('sha256').update(bytes as Uint8Array).digest('hex');
type Journal = {
  subject: string; at: number; lease: string; busyUntil: number;
  authority: string; sponsor: string; amountAtomic: string; ata: string;
  signed?: string; signature?: string; messageSha256?: string; lastValidBlockHeight?: string;
  done?: boolean;
};
type Ledger = { accounts: Record<string, number>; wallets: Record<string, Journal>; day: string; count: number };
type Client = Pick<RpcSolanaGateway, 'checkedGenesis' | 'multiple' | 'lifetime' | 'simulate' | 'broadcast' | 'reconcile' | 'rpc'>;
type Options = { environment?: Record<string, string | undefined>; client?: Client; now?: () => number };

function positiveInteger(value: string | undefined, fallback: number) {
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('Invalid test USDC faucet amount or daily cap.');
  return Number(value);
}

/** Only the server's verified identity may select the recipient; no request amount or wallet is accepted. */
export async function mintTestUsdc(store: Store, subject: string, verifiedWallet: string, options: Options = {}) {
  const environment = options.environment ?? process.env;
  if (!environment.SOLANA_TEST_USDC_MINT_AUTHORITY?.trim() || !environment.SOLANA_SPONSOR_KEYPAIR?.trim())
    return { status: 'unconfigured' as const };
  const config = solanaConfiguration(environment);
  if (!config || config.cluster !== 'devnet' || config.ledgerDepositMint !== SOLANA_TEST_USDC_MINT)
    return { status: 'unconfigured' as const };
  const raw: unknown = JSON.parse(environment.SOLANA_TEST_USDC_MINT_AUTHORITY);
  if (!Array.isArray(raw) || raw.length !== 64 || raw.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
    throw new Error('Invalid test USDC mint authority configuration.');
  const authority = await createKeyPairSignerFromBytes(new Uint8Array(raw));
  const sponsor = (await configuredFeeSponsor(environment))!;
  const owner = address(verifiedWallet);
  if (owner === authority.address || owner === sponsor.address || authority.address === sponsor.address)
    throw new ConflictError('The faucet needs separate mint authority, fee sponsor and personal wallet.');
  const amount = BigInt(positiveInteger(environment.SOLANA_TEST_USDC_AMOUNT, 10_000)) * 1_000_000n;
  if (amount > 18_446_744_073_709_551_615n) throw new Error('Test USDC amount exceeds the token limit.');
  const cap = positiveInteger(environment.SOLANA_TEST_USDC_DAILY_CAP, 200);
  const client = options.client ?? new RpcSolanaGateway(config);
  const at = (options.now ?? Date.now)();
  const lease = randomUUID();
  const [ata] = await findAssociatedTokenPda({ owner, mint: address(SOLANA_TEST_USDC_MINT), tokenProgram: address(SOLANA_IDS.token) });
  try { await store.create<Ledger>(KEY, { accounts: {}, wallets: {}, day: '', count: 0 }); }
  catch (error) { if (!await store.get(KEY)) throw error; }
  const ledger = await store.update<Ledger>(KEY, (value) => {
    for (const [wallet, entry] of Object.entries(value.wallets)) {
      if (!entry.signed && entry.busyUntil <= at) {
        delete value.wallets[wallet];
        if (value.accounts[entry.subject] === entry.at) delete value.accounts[entry.subject];
        if (value.day === new Date(entry.at).toISOString().slice(0, 10)) value.count--;
      } else if (entry.done && entry.at + DAY <= at) delete value.wallets[wallet];
    }
    for (const [account, last] of Object.entries(value.accounts)) {
      if (last + DAY <= at) delete value.accounts[account];
    }
    const existing = value.wallets[owner];
    if (existing && !existing.done) {
      if (existing.subject !== subject) throw new ConflictError('This wallet already has an unresolved test USDC mint.');
      if (existing.busyUntil > at) throw new ConflictError('A test USDC mint for this wallet is already in flight.');
      if (existing.authority !== authority.address || existing.sponsor !== sponsor.address)
        throw new ConflictError('Restore the original faucet authority and sponsor to recover this mint.');
      existing.lease = lease; existing.busyUntil = at + 60_000;
      return value;
    }
    // Unresolved signed operations remain charged across days and wallet changes.
    if (Object.values(value.wallets).some((entry) => entry.subject === subject && !entry.done))
      throw new ConflictError('Recover your pending test USDC mint with its original wallet first.');
    if ((value.accounts[subject] ?? -DAY) + DAY > at || (existing && existing.at + DAY > at))
      throw new ConflictError('Test USDC is limited to once per 24 hours per account and wallet.');
    const day = new Date(at).toISOString().slice(0, 10);
    if (value.day !== day) { value.day = day; value.count = 0; }
    if (value.count >= cap) throw new ConflictError('This site has reached its daily test USDC limit. Try tomorrow.');
    value.count++;
    value.accounts[subject] = at;
    value.wallets[owner] = { subject, at, lease, busyUntil: at + 60_000, authority: authority.address, sponsor: sponsor.address, amountAtomic: amount.toString(), ata };
    return value;
  });
  let journal = ledger.wallets[owner];
  const persist = async (change: (value: Journal) => Journal) => {
    const saved = await store.update<Ledger>(KEY, (value) => {
      if (value.wallets[owner]?.lease !== lease) throw new ConflictError('Test USDC reservation changed. Retry to recover it.');
      value.wallets[owner] = change(value.wallets[owner]);
      return value;
    });
    journal = saved.wallets[owner];
  };
  const observe = () => client.reconcile(journal.signature!, journal.messageSha256!, [{
    account: journal.ata, mint: SOLANA_TEST_USDC_MINT, owner, direction: 'credit',
    minimumAtomic: journal.amountAtomic, maximumAtomic: journal.amountAtomic, allowCreated: true,
  }]);
  const finish = async (result: SignatureReconciliation) => {
    if (result.status === 'finalized') {
      await persist((value) => ({ ...value, done: true }));
      return { status: 'confirmed' as const, signature: journal.signature!, amountAtomic: journal.amountAtomic };
    }
    if (result.status === 'failed') {
      await persist((value) => ({ ...value, done: true }));
      throw new ConflictError('The test USDC mint failed. No replacement transaction was sent.');
    }
    return null;
  };
  try {
    await client.checkedGenesis();
    if (!journal.signed) {
      const row = (await client.multiple([SOLANA_TEST_USDC_MINT])).accounts[0];
      if (!row || row.owner !== SOLANA_IDS.token || row.executable || row.data.length !== 82)
        throw new Error('The test USDC mint is unavailable.');
      const mint = getMintDecoder().decode(row.data);
      if (!mint.isInitialized || mint.decimals !== 6 || !isSome(mint.mintAuthority)
        || mint.mintAuthority.value !== authority.address || isSome(mint.freezeAuthority))
        throw new Error('The test USDC mint does not match the configured authority and reviewed token.');
      const lifetime = await client.lifetime();
      const transaction = compileTransaction(pipe(
        createTransactionMessage({ version: 0 }),
        (message) => setTransactionMessageFeePayer(address(sponsor.address), message),
        (message) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(lifetime.blockhash), lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) }, message),
        (message) => appendTransactionMessageInstructions([
          getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(address(sponsor.address)), ata, owner, mint: address(SOLANA_TEST_USDC_MINT), tokenProgram: address(SOLANA_IDS.token) }),
          getMintToCheckedInstruction({ mint: address(SOLANA_TEST_USDC_MINT), token: ata, mintAuthority: authority, amount: BigInt(journal.amountAtomic), decimals: 6 }, { programAddress: address(SOLANA_IDS.token) }),
        ], message),
      ));
      const authoritySigned = getTransactionEncoder().encode(await partiallySignTransaction([authority.keyPair], transaction));
      const signed = await sponsor.sign(authoritySigned as Uint8Array);
      // Simulation includes the sponsor's fee and ATA rent ceiling. Nothing is broadcast before durable storage.
      await client.simulate(signed, sponsor.address, owner);
      const decoded = getTransactionDecoder().decode(signed);
      const signature = getBase58Decoder().decode(decoded.signatures[address(sponsor.address)]!);
      await persist((value) => ({ ...value, signed: Buffer.from(signed).toString('base64'), signature, messageSha256: digest(decoded.messageBytes), lastValidBlockHeight: lifetime.lastValidBlockHeight }));
    }
    const signed = Buffer.from(journal.signed!, 'base64');
    const transaction = getTransactionDecoder().decode(signed);
    if (journal.ata !== ata || digest(transaction.messageBytes) !== journal.messageSha256
      || getBase58Decoder().decode(transaction.signatures[address(sponsor.address)]!) !== journal.signature)
      throw new Error('The test USDC journal does not match the verified wallet and transaction.');
    const observed = await observe();
    const completed = await finish(observed);
    if (completed) return completed;
    // Only a successful absence observation permits rebroadcast. Unknown RPC evidence is never absence.
    if (observed.status === 'unknown' && observed.reason === 'signature-not-observed-do-not-resubmit-new-intent') {
      const height = await client.rpc('getBlockHeight', [{ commitment: 'finalized' }]);
      if (!Number.isSafeInteger(height) || Number(height) < 0) throw new Error('Block height unavailable.');
      if (BigInt(Number(height)) > BigInt(journal.lastValidBlockHeight!)) {
        await persist((value) => ({ ...value, done: true }));
        throw new ConflictError('The test USDC mint expired without confirmation. No replacement transaction was sent.');
      }
      try { await client.broadcast(signed); }
      catch { /* Ambiguous send retains the exact bytes; a retry observes them before any rebroadcast. */ }
      const confirmed = await finish(await observe());
      if (confirmed) return confirmed;
    }
    return { status: 'pending' as const, signature: journal.signature! };
  } finally {
    await store.update<Ledger>(KEY, (value) => {
      const current = value.wallets[owner];
      if (current?.lease !== lease) return value;
      if (!current.signed) {
        delete value.wallets[owner];
        if (value.accounts[subject] === current.at) delete value.accounts[subject];
        if (value.day === new Date(current.at).toISOString().slice(0, 10)) value.count--;
      } else current.busyUntil = 0;
      return value;
    });
  }
}
