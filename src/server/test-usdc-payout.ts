import { createHash } from 'node:crypto';
import {
  address, appendTransactionMessageInstructions, blockhash, compileTransaction, createKeyPairSignerFromBytes,
  createNoopSigner, createTransactionMessage, getBase58Decoder, getTransactionDecoder, getTransactionEncoder,
  isSome, partiallySignTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address, type KeyPairSigner,
} from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getMintDecoder, getMintToCheckedInstruction } from '@solana-program/token-2022';
import { SOLANA_IDS, SOLANA_TEST_USDC_MINT } from '../finance/solana/index.ts';
import { ConflictError } from './errors.ts';
import { RpcSolanaGateway, solanaConfiguration } from './solana-rpc.ts';
import { configuredFeeSponsor, type FeeSponsor } from './solana-service.ts';

export type TestUsdcClient = Pick<RpcSolanaGateway, 'checkedGenesis' | 'multiple' | 'lifetime' | 'simulate' | 'broadcast' | 'reconcile' | 'rpc'>;
export type MintJournal = {
  authority: string; sponsor: string; amountAtomic: string; ata: string;
  signed?: string; signature?: string; messageSha256?: string; lastValidBlockHeight?: string;
};
export type TestUsdcPayoutContext = { authority: KeyPairSigner; sponsor: FeeSponsor; owner: Address; ata: Address; client: TestUsdcClient };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function testUsdcPayoutContext(verifiedWallet: string, environment: Record<string, string | undefined>, injected?: TestUsdcClient): Promise<TestUsdcPayoutContext | null> {
  if (!environment.SOLANA_TEST_USDC_MINT_AUTHORITY?.trim() || !environment.SOLANA_SPONSOR_KEYPAIR?.trim()) return null;
  const config = solanaConfiguration(environment);
  if (!config || config.cluster !== 'devnet' || config.ledgerDepositMint !== SOLANA_TEST_USDC_MINT) return null;
  const raw: unknown = JSON.parse(environment.SOLANA_TEST_USDC_MINT_AUTHORITY);
  if (!Array.isArray(raw) || raw.length !== 64 || raw.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
    throw new Error('Invalid test USDC mint authority configuration.');
  const authority = await createKeyPairSignerFromBytes(new Uint8Array(raw));
  const sponsor = (await configuredFeeSponsor(environment))!;
  const owner = address(verifiedWallet);
  if (owner === authority.address || owner === sponsor.address || authority.address === sponsor.address)
    throw new ConflictError('The faucet needs separate mint authority, fee sponsor and personal wallet.');
  const [ata] = await findAssociatedTokenPda({ owner, mint: address(SOLANA_TEST_USDC_MINT), tokenProgram: address(SOLANA_IDS.token) });
  return { authority, sponsor, owner, ata, client: injected ?? new RpcSolanaGateway(config) };
}

/** Persist exact signed bytes before broadcast; unknown evidence never authorizes a new intent. */
export async function executeTestUsdcPayout(
  context: TestUsdcPayoutContext,
  initial: MintJournal,
  persist: (journal: MintJournal) => Promise<void>,
) {
  const { authority, sponsor, owner, ata, client } = context;
  let journal = initial;
  if (journal.authority !== authority.address || journal.sponsor !== sponsor.address || journal.ata !== ata)
    throw new ConflictError('Restore the original faucet authority, sponsor and wallet to recover this mint.');
  const amount = BigInt(journal.amountAtomic);
  if (amount <= 0n || amount > 18_446_744_073_709_551_615n) throw new Error('Test USDC amount exceeds the token limit.');
  await client.checkedGenesis();
  if (!journal.signed) {
    const row = (await client.multiple([SOLANA_TEST_USDC_MINT])).accounts[0];
    if (!row || row.owner !== SOLANA_IDS.token || row.executable || row.data.length !== 82) throw new Error('The test USDC mint is unavailable.');
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
        getMintToCheckedInstruction({ mint: address(SOLANA_TEST_USDC_MINT), token: ata, mintAuthority: authority, amount, decimals: 6 }, { programAddress: address(SOLANA_IDS.token) }),
      ], message),
    ));
    const authoritySigned = getTransactionEncoder().encode(await partiallySignTransaction([authority.keyPair], transaction));
    const signed = await sponsor.sign(authoritySigned as Uint8Array);
    await client.simulate(signed, sponsor.address, owner);
    const decoded = getTransactionDecoder().decode(signed);
    journal = { ...journal, signed: Buffer.from(signed).toString('base64'), signature: getBase58Decoder().decode(decoded.signatures[address(sponsor.address)]!), messageSha256: digest(new Uint8Array(decoded.messageBytes)), lastValidBlockHeight: lifetime.lastValidBlockHeight };
    await persist(journal);
  }
  const signed = Buffer.from(journal.signed!, 'base64');
  const transaction = getTransactionDecoder().decode(signed);
  if (digest(new Uint8Array(transaction.messageBytes)) !== journal.messageSha256
    || getBase58Decoder().decode(transaction.signatures[address(sponsor.address)]!) !== journal.signature)
    throw new Error('The test USDC journal does not match the verified wallet and transaction.');
  const observe = () => client.reconcile(journal.signature!, journal.messageSha256!, [{
    account: ata, mint: SOLANA_TEST_USDC_MINT, owner, direction: 'credit',
    minimumAtomic: journal.amountAtomic, maximumAtomic: journal.amountAtomic, allowCreated: true,
  }]);
  const result = await observe();
  if (result.status === 'finalized') return { status: 'confirmed' as const, signature: journal.signature!, amountAtomic: journal.amountAtomic };
  if (result.status === 'failed') return { status: 'failed' as const, signature: journal.signature! };
  if (result.status === 'unknown' && result.reason === 'signature-not-observed-do-not-resubmit-new-intent') {
    const height = await client.rpc('getBlockHeight', [{ commitment: 'finalized' }]);
    if (!Number.isSafeInteger(height) || Number(height) < 0) throw new Error('Block height unavailable.');
    if (BigInt(Number(height)) > BigInt(journal.lastValidBlockHeight!)) return { status: 'expired' as const, signature: journal.signature! };
    try { await client.broadcast(signed); } catch { /* Recover exact bytes after ambiguous sends. */ }
    const observed = await observe();
    if (observed.status === 'finalized') return { status: 'confirmed' as const, signature: journal.signature!, amountAtomic: journal.amountAtomic };
    if (observed.status === 'failed') return { status: 'failed' as const, signature: journal.signature! };
  }
  return { status: 'pending' as const, signature: journal.signature! };
}
