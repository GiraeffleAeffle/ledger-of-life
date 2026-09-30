import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { address, getAddressDecoder, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { findAssociatedTokenPda, getMintEncoder, getMintToCheckedInstructionDataDecoder } from '@solana-program/token-2022';
import { SOLANA_DEVNET_MANIFEST, SOLANA_IDS, SOLANA_TEST_USDC_MINT, type ExpectedTokenDelta, type SignatureReconciliation } from '../finance/solana/index.ts';
import { LocalStore, type Store } from './store.ts';
import { mintTestUsdc } from './test-usdc.ts';

const key = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
function keypair(byte: number) {
  const seed = Buffer.alloc(32, byte);
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const publicBytes = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { address: getAddressDecoder().decode(publicBytes), json: JSON.stringify([...seed, ...publicBytes]) };
}
const authority = keypair(31);
const sponsor = keypair(32);
const owner = keypair(33).address;
const other = keypair(34).address;
async function fixture(filename = ':memory:') {
  const store = new LocalStore(filename);
  const state = { time: Date.UTC(2026, 8, 30, 12), height: 100, genesis: String(SOLANA_DEVNET_MANIFEST.genesisHash),
    pending: false, unknown: false, failSimulation: false, wrongMint: false, reads: 0, broadcasts: [] as Uint8Array[], amounts: [] as string[] };
  const client = {
    checkedGenesis: async () => {
      if (state.genesis !== SOLANA_DEVNET_MANIFEST.genesisHash) throw new Error('RPC genesis mismatch');
      return state.genesis;
    },
    multiple: async () => ({ slot: '50', accounts: [{ address: SOLANA_TEST_USDC_MINT, owner: SOLANA_IDS.token, executable: false, lamports: '1461600',
      data: new Uint8Array(getMintEncoder().encode({ mintAuthority: state.wrongMint ? address(other) : authority.address, supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: null, extensions: null })) }] }),
    lifetime: async () => { state.reads++; return { blockhash: key(40 + state.reads), lastValidBlockHeight: '200', blockHeight: String(state.height) }; },
    simulate: async () => {
      if (state.failSimulation) throw new Error('Sponsor fee and rent ceiling exceeded');
      return { slot: '50', sponsorDebitCeilingLamports: '2049280', networkFeeLamports: '10000' };
    },
    broadcast: async (bytes: Uint8Array) => {
      const ledger = await store.get<{ wallets: Record<string, { signed?: string }> }>('solana-test-usdc:devnet');
      assert.ok(Object.values(ledger!.wallets).some((row) => row.signed === Buffer.from(bytes).toString('base64')));
      state.broadcasts.push(bytes);
      return 'accepted';
    },
    reconcile: async (signature: string, _hash: string, deltas: readonly ExpectedTokenDelta[]): Promise<SignatureReconciliation> => {
      state.amounts.push(deltas[0].minimumAtomic);
      assert.equal(deltas[0].mint, SOLANA_TEST_USDC_MINT);
      assert.equal(deltas[0].allowCreated, true);
      if (state.unknown) return { status: 'unknown', reason: 'rpc-evidence-unavailable' };
      if (!state.broadcasts.some((bytes) => getBase58Decoder().decode(getTransactionDecoder().decode(bytes).signatures[sponsor.address]!) === signature))
        return { status: 'unknown', reason: 'signature-not-observed-do-not-resubmit-new-intent' };
      if (state.pending) return { status: 'pending', reason: 'awaiting-finality' };
      return { status: 'finalized', signature, slot: '55', deltas: [{ account: deltas[0].account, signedAtomic: deltas[0].minimumAtomic }] };
    },
    rpc: async () => state.height,
  };
  const environment: Record<string, string | undefined> = {
    SOLANA_TEST_USDC_MINT_AUTHORITY: authority.json, SOLANA_SPONSOR_KEYPAIR: sponsor.json, SOLANA_RPC_URL: 'https://rpc.example',
    SOLANA_DEPLOYMENT_MANIFEST: JSON.stringify({ cluster: 'devnet', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash,
      escrowProgram: key(10), programSha256: 'a'.repeat(64), programCodeLength: 1000, upgradeAuthority: null,
      depositMint: SOLANA_DEVNET_MANIFEST.deposit.mint, ledgerDepositMint: SOLANA_TEST_USDC_MINT,
      reserve: key(11), market: key(12), receiptMint: key(13), liquiditySupply: key(14), marketAuthority: key(15),
      oracleAccounts: [], maxObservationAgeMs: 15000, agreementId: 'fixture', tenancyAddress: key(16), maximumSponsorLamports: '10000000' }),
  };
  return { store, state, options: { environment, client, now: () => state.time } };
}

test('mints fixed 10,000 tUSDC to the verified wallet ATA, sponsor pays, and limits both identity and wallet for 24 hours', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  const result = await mintTestUsdc(f.store, 'person', owner, f.options);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.amountAtomic, '10000000000');
  const decoded = getTransactionDecoder().decode(f.state.broadcasts[0]);
  const message = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  assert.equal(message.staticAccounts[0], sponsor.address);
  assert.ok(decoded.signatures[sponsor.address]); assert.ok(decoded.signatures[authority.address]);
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(SOLANA_TEST_USDC_MINT), tokenProgram: address(SOLANA_IDS.token) });
  const instruction = message.instructions[1];
  assert.equal(message.staticAccounts[instruction.programAddressIndex], SOLANA_IDS.token);
  assert.deepEqual(instruction.accountIndices!.map((index) => message.staticAccounts[index]), [SOLANA_TEST_USDC_MINT, ata, authority.address]);
  assert.deepEqual(getMintToCheckedInstructionDataDecoder().decode(instruction.data!), { discriminator: 14, amount: 10000000000n, decimals: 6 });
  f.state.time += 86_399_999;
  await assert.rejects(mintTestUsdc(f.store, 'person', other, f.options), /once per 24 hours/);
  await assert.rejects(mintTestUsdc(f.store, 'other-person', owner, f.options), /once per 24 hours/);
  assert.equal(f.state.broadcasts.length, 1);
  f.state.time++;
  assert.equal((await mintTestUsdc(f.store, 'person', owner, f.options)).status, 'confirmed');
});

test('global cap counts concurrent reservations atomically and resets on the next UTC day', async (t) => {
  const f = await fixture(); t.after(() => f.store.close()); f.options.environment.SOLANA_TEST_USDC_DAILY_CAP = '1';
  const results = await Promise.allSettled([mintTestUsdc(f.store, 'person', owner, f.options), mintTestUsdc(f.store, 'other', other, f.options)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(f.state.broadcasts.length, 1);
  const loser = results[0].status === 'rejected' ? ['person', owner] : ['other', other];
  await assert.rejects(mintTestUsdc(f.store, loser[0], loser[1], f.options), /daily test USDC limit/);
  f.state.time = Date.UTC(2026, 9, 1);
  assert.equal((await mintTestUsdc(f.store, loser[0], loser[1], f.options)).status, 'confirmed');
});

test('pending recovery keeps identical signed bytes and original amount even after configuration changes', async (t) => {
  const f = await fixture(); t.after(() => f.store.close()); f.state.pending = true;
  const pending = await mintTestUsdc(f.store, 'person', owner, f.options);
  assert.equal(pending.status, 'pending');
  f.options.environment.SOLANA_TEST_USDC_AMOUNT = '2700';
  f.options.client.lifetime = async () => { throw new Error('must not sign again'); };
  f.state.time += 2 * 86_400_000;
  await assert.rejects(mintTestUsdc(f.store, 'person', other, f.options), /original wallet/);
  f.state.pending = false;
  const recovered = await mintTestUsdc(f.store, 'person', owner, f.options);
  assert.equal(recovered.status, 'confirmed'); assert.equal(recovered.signature, pending.signature);
  assert.equal(recovered.amountAtomic, '10000000000'); assert.equal(f.state.broadcasts.length, 1);
});

test('unknown RPC evidence never broadcasts; later absence safely rebroadcasts the original journal only', async (t) => {
  const f = await fixture(); t.after(() => f.store.close()); f.state.unknown = true;
  const first = await mintTestUsdc(f.store, 'person', owner, f.options);
  assert.equal(first.status, 'pending'); assert.equal(f.state.broadcasts.length, 0);
  f.state.unknown = false;
  assert.equal((await mintTestUsdc(f.store, 'person', owner, f.options)).status, 'confirmed');
  assert.equal(f.state.reads, 1);
  assert.equal(f.state.broadcasts.length, 1);
});

test('failed durable write prevents broadcast and refunds the unsigned reservation', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  const store: Store = {
    get: f.store.get.bind(f.store), create: f.store.create.bind(f.store), scan: f.store.scan.bind(f.store), close: async () => {},
    update: async (key, change) => f.store.update(key, (value) => {
      const next = change(value);
      if (JSON.stringify(next).includes('"signed"')) throw new Error('storage unavailable');
      return next;
    }),
  };
  await assert.rejects(mintTestUsdc(store, 'person', owner, f.options), /storage unavailable/);
  assert.equal(f.state.broadcasts.length, 0);
  assert.equal((await mintTestUsdc(f.store, 'person', owner, f.options)).status, 'confirmed');
});

for (const failure of ['genesis', 'mint', 'rent'] as const) {
  test(`refuses unsafe ${failure} before broadcast and permits retry after configuration recovery`, async (t) => {
    const f = await fixture(); t.after(() => f.store.close());
    if (failure === 'genesis') f.state.genesis = 'wrong';
    if (failure === 'mint') f.state.wrongMint = true;
    if (failure === 'rent') f.state.failSimulation = true;
    await assert.rejects(mintTestUsdc(f.store, 'person', owner, f.options));
    assert.equal(f.state.broadcasts.length, 0);
    f.state.genesis = SOLANA_DEVNET_MANIFEST.genesisHash; f.state.wrongMint = false; f.state.failSimulation = false;
    assert.equal((await mintTestUsdc(f.store, 'person', owner, f.options)).status, 'confirmed');
  });
}

test('unconfigured faucet does not read RPC or reserve quota; invalid amounts fail closed', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  assert.deepEqual(await mintTestUsdc(f.store, 'person', owner, { ...f.options, environment: {} }), { status: 'unconfigured' });
  assert.equal(await f.store.get('solana-test-usdc:devnet'), null);
  f.options.environment.SOLANA_TEST_USDC_AMOUNT = '-1';
  await assert.rejects(mintTestUsdc(f.store, 'person', owner, f.options), /amount or daily cap/);
  assert.equal(f.state.broadcasts.length, 0);
});

test('expired signed transaction is never replaced or rebroadcast and still consumes its daily reservation', async (t) => {
  const f = await fixture(); t.after(() => f.store.close()); f.state.unknown = true;
  assert.equal((await mintTestUsdc(f.store, 'person', owner, f.options)).status, 'pending');
  f.state.unknown = false; f.state.height = 201;
  await assert.rejects(mintTestUsdc(f.store, 'person', owner, f.options), /expired/);
  await assert.rejects(mintTestUsdc(f.store, 'person', owner, f.options), /once per 24 hours/);
  assert.equal(f.state.broadcasts.length, 0); assert.equal(f.state.reads, 1);
});

test('ambiguous failed broadcast recovers by resending only identical signed bytes', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  const send = f.options.client.broadcast;
  let attempted: Uint8Array | undefined;
  f.options.client.broadcast = async (bytes) => { attempted = bytes; throw new Error('connection lost'); };
  const first = await mintTestUsdc(f.store, 'person', owner, f.options);
  assert.equal(first.status, 'pending'); assert.ok(attempted);
  f.options.client.broadcast = send;
  const recovered = await mintTestUsdc(f.store, 'person', owner, f.options);
  assert.equal(recovered.status, 'confirmed'); assert.equal(recovered.signature, first.signature);
  assert.deepEqual(f.state.broadcasts[0], attempted); assert.equal(f.state.reads, 1);
});

test('same-wallet concurrent requests mint only once and changing wallets does not bypass the account limit', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  const results = await Promise.allSettled([mintTestUsdc(f.store, 'person', owner, f.options), mintTestUsdc(f.store, 'person', owner, f.options)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(f.state.broadcasts.length, 1);
  await assert.rejects(mintTestUsdc(f.store, 'person', other, f.options), /once per 24 hours/);
});

test('a process restart recovers the persisted mint and keeps the cooldown durable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-faucet-'));
  const filename = join(directory, 'faucet.sqlite');
  let store: LocalStore | undefined;
  try {
    const f = await fixture(filename); store = f.store; f.state.pending = true;
    const first = await mintTestUsdc(store, 'person', owner, f.options);
    assert.equal(first.status, 'pending');
    await store.close(); store = new LocalStore(filename);
    f.state.pending = false;
    f.options.client.lifetime = async () => { throw new Error('must recover without signing'); };
    const recovered = await mintTestUsdc(store, 'person', owner, f.options);
    assert.equal(recovered.status, 'confirmed'); assert.equal(recovered.signature, first.signature);
    await assert.rejects(mintTestUsdc(store, 'person', other, f.options), /once per 24 hours/);
    await assert.rejects(mintTestUsdc(store, 'other-person', owner, f.options), /once per 24 hours/);
    assert.equal(f.state.broadcasts.length, 1);
  } finally {
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('configured fixed amount is encoded in six-decimal units, never taken from the caller', async (t) => {
  const f = await fixture(); t.after(() => f.store.close());
  f.options.environment.SOLANA_TEST_USDC_AMOUNT = '2700';
  const result = await mintTestUsdc(f.store, 'person', owner, f.options);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.amountAtomic, '2700000000');
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(f.state.broadcasts[0]).messageBytes);
  assert.equal(getMintToCheckedInstructionDataDecoder().decode(message.instructions[1].data!).amount, 2700000000n);
});
