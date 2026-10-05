import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountRole, appendTransactionMessageInstructions, blockhash, compileTransaction, createTransactionMessage, generateKeyPairSigner, getAddressEncoder, getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { SOLANA_DEVNET_MANIFEST, SOLANA_IDS } from '../finance/solana/manifest.ts';
import { createBaseSolanaGateway } from './solana-rpc.ts';

async function fixture() {
  const [sponsor, actor, source, destination, mint] = await Promise.all(Array.from({ length: 5 }, () => generateKeyPairSigner()));
  let credit = 100n, owner = actor.address;
  let genesis: string = SOLANA_DEVNET_MANIFEST.genesisHash;
  const token = (balance: bigint, authority = actor.address) => {
    const data = new Uint8Array(165); data.set(getAddressEncoder().encode(mint.address)); data.set(getAddressEncoder().encode(authority), 32); new DataView(data.buffer).setBigUint64(64, balance, true); data[108] = 1;
    return { owner: SOLANA_IDS.token, executable: false, lamports: 2_039_280, data: [Buffer.from(data).toString('base64'), 'base64'] };
  };
  const payer = { owner: SOLANA_IDS.system, executable: false, lamports: 100_000_000, data: ['', 'base64'] };
  const mintAccount = { owner: SOLANA_IDS.token, executable: false, lamports: 1_461_600, data: [Buffer.from(new Uint8Array(82)).toString('base64'), 'base64'] };
  const fetcher: typeof fetch = async (_, options) => {
    const body = JSON.parse(String(options?.body));
    let result: unknown;
    if (body.method === 'getGenesisHash') result = genesis;
    else if (body.method === 'getLatestBlockhash') result = { context: { slot: 10 }, value: { blockhash: SOLANA_IDS.system, lastValidBlockHeight: 100 } };
    else if (body.method === 'getBlockHeight') result = 10;
    else if (body.method === 'getFeeForMessage') result = { context: { slot: 10 }, value: 10000 };
    else if (body.method === 'getMultipleAccounts') result = { context: { slot: 10 }, value: body.params[0].map((key: string) => key === sponsor.address ? payer : key === source.address ? token(1000n) : key === destination.address ? token(0n) : key === mint.address ? mintAccount : null) };
    else if (body.method === 'simulateTransaction') result = { context: { slot: 10 }, value: { err: null, accounts: body.params[1].accounts.addresses.map((key: string) => key === sponsor.address ? { ...payer, lamports: 99_990_000 } : key === source.address ? token(900n) : key === destination.address ? token(credit, owner) : key === mint.address ? mintAccount : null) } };
    else throw new Error(`Unexpected RPC ${body.method}`);
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  };
  const gateway = createBaseSolanaGateway({ rpcUrl: 'https://rpc.example', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash, maximumSponsorLamports: '10000000' }, fetcher);
  const message = pipe(createTransactionMessage({ version: 0 }), msg => setTransactionMessageFeePayer(sponsor.address, msg), msg => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(SOLANA_IDS.system), lastValidBlockHeight: 100n }, msg), msg => appendTransactionMessageInstructions([{ programAddress: MEMO_PROGRAM_ADDRESS, accounts: [{ address: actor.address, role: AccountRole.READONLY_SIGNER }, { address: source.address, role: AccountRole.WRITABLE }, { address: destination.address, role: AccountRole.WRITABLE }, { address: mint.address, role: AccountRole.WRITABLE }], data: new Uint8Array() }], msg));
  const bytes = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
  const expected = [{ account: source.address, mint: mint.address, owner: actor.address, direction: 'debit' as const, minimumAtomic: '100', maximumAtomic: '100' }, { account: destination.address, mint: mint.address, owner: actor.address, direction: 'credit' as const, minimumAtomic: '100', maximumAtomic: '100' }];
  return { gateway, bytes, sponsor, actor, expected, setCredit: (value: bigint) => { credit = value; }, setOwner: (value: typeof owner) => { owner = value; }, setGenesis: (value: string) => { genesis = value; } };
}

test('base gateway uses existing lifetime machinery and refuses another genesis without escrow config', async () => {
  const f = await fixture(); assert.deepEqual(await f.gateway.lifetime(), { blockhash: SOLANA_IDS.system, lastValidBlockHeight: '100', blockHeight: '10' });
  f.setGenesis('wrong-network'); await assert.rejects(f.gateway.lifetime(), /genesis mismatch/);
});

test('optional simulated token expectations pin exact debits, credits, mint and owner', async () => {
  const f = await fixture();
  assert.equal((await f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected)).sponsorDebitCeilingLamports, '20000');
  f.setCredit(99n); await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected), /delta differs/);
  // No fourth argument preserves the existing escrow simulation behaviour.
  assert.equal((await f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address)).sponsorDebitCeilingLamports, '20000');
  f.setCredit(100n); f.setOwner(f.sponsor.address); await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected), /owner or mint/);
});

test('simulation rejects an unreviewed token loss from a reviewed owner', async () => {
  const f = await fixture();
  await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, [f.expected[1]]), /Unexpected simulated token loss/);
});
