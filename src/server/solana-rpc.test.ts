import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountRole, appendTransactionMessageInstructions, blockhash, compileTransaction, createTransactionMessage, generateKeyPairSigner, getAddressEncoder, getCompiledTransactionMessageDecoder, getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { SOLANA_DEVNET_MANIFEST, SOLANA_IDS } from '../finance/solana/manifest.ts';
import { createBaseSolanaGateway } from './solana-rpc.ts';

type RpcAccount = { owner: string; executable: boolean; lamports: number; data: string[] };
type TokenBalance = { accountIndex: number; mint: string; owner?: string; programId?: string; uiTokenAmount: { amount: string; decimals: number } };
type SimulationValue = { err: unknown; accounts: (RpcAccount | null)[]; preBalances: number[]; postBalances: number[];
  preTokenBalances: TokenBalance[]; postTokenBalances: TokenBalance[]; fee: number | null; loadedAddresses: { writable: string[]; readonly: string[] } };

async function fixture() {
  const [sponsor, actor, source, destination, mint] = await Promise.all(Array.from({ length: 5 }, () => generateKeyPairSigner()));
  let credit = 100n, owner = actor.address, genesis: string = SOLANA_DEVNET_MANIFEST.genesisHash;
  let mutate: (value: SimulationValue) => void = () => {};
  const calls: string[] = [];
  const token = (balance: bigint, authority = actor.address): RpcAccount => {
    const data = new Uint8Array(165); data.set(getAddressEncoder().encode(mint.address)); data.set(getAddressEncoder().encode(authority), 32);
    new DataView(data.buffer).setBigUint64(64, balance, true); data[108] = 1;
    return { owner: SOLANA_IDS.token, executable: false, lamports: 2_039_280, data: [Buffer.from(data).toString('base64'), 'base64'] };
  };
  const payer: RpcAccount = { owner: SOLANA_IDS.system, executable: false, lamports: 100_000_000, data: ['', 'base64'] };
  const mintAccount: RpcAccount = { owner: SOLANA_IDS.token, executable: false, lamports: 1_461_600, data: [Buffer.from(new Uint8Array(82)).toString('base64'), 'base64'] };
  const message = pipe(createTransactionMessage({ version: 0 }), msg => setTransactionMessageFeePayer(sponsor.address, msg),
    msg => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(SOLANA_IDS.system), lastValidBlockHeight: 100n }, msg),
    msg => appendTransactionMessageInstructions([{ programAddress: MEMO_PROGRAM_ADDRESS, accounts: [
      { address: actor.address, role: AccountRole.READONLY_SIGNER }, { address: source.address, role: AccountRole.WRITABLE },
      { address: destination.address, role: AccountRole.WRITABLE }, { address: mint.address, role: AccountRole.WRITABLE }], data: new Uint8Array() }], msg));
  const transaction = compileTransaction(message), bytes = new Uint8Array(getTransactionEncoder().encode(transaction));
  const accountKeys = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes).staticAccounts;
  const index = { actor: accountKeys.indexOf(actor.address), source: accountKeys.indexOf(source.address), destination: accountKeys.indexOf(destination.address) };
  const balance = (key: typeof source.address, amount: bigint, authority = actor.address): TokenBalance => ({ accountIndex: accountKeys.indexOf(key),
    mint: mint.address, owner: authority, programId: SOLANA_IDS.token, uiTokenAmount: { amount: amount.toString(), decimals: 6 } });
  const native = () => accountKeys.map(key => key === sponsor.address ? payer.lamports : key === actor.address ? 10_000_000 :
    key === source.address || key === destination.address ? 2_039_280 : key === mint.address ? mintAccount.lamports : 0);
  const fetcher: typeof fetch = async (_, options) => {
    const body = JSON.parse(String(options?.body)); calls.push(body.method);
    let result: unknown;
    if (body.method === 'getGenesisHash') result = genesis;
    else if (body.method === 'getLatestBlockhash') result = { context: { slot: 10 }, value: { blockhash: SOLANA_IDS.system, lastValidBlockHeight: 100 } };
    else if (body.method === 'getBlockHeight') result = body.params[0].commitment === 'confirmed' ? 12 : 10;
    else if (body.method === 'simulateTransaction') {
      assert.equal(body.params[0], Buffer.from(bytes).toString('base64'));
      assert.equal(body.params[1].commitment, 'finalized');
      assert.equal(body.params[1].replaceRecentBlockhash, false);
      const preBalances = native(), postBalances = native(); postBalances[0] -= 10000;
      const value: SimulationValue = { err: null, accounts: body.params[1].accounts.addresses.map((key: string) =>
        key === sponsor.address ? { ...payer, lamports: 99_990_000 } : key === source.address ? token(900n) :
          key === destination.address ? token(credit, owner) : key === mint.address ? mintAccount : null),
      preBalances, postBalances, preTokenBalances: [balance(source.address, 1000n), balance(destination.address, 0n)],
      postTokenBalances: [balance(source.address, 900n), balance(destination.address, credit, owner)], fee: 10000,
      loadedAddresses: { writable: [], readonly: [] } };
      mutate(value);
      result = { context: { slot: 10 }, value };
    } else throw new Error(`Unexpected RPC ${body.method}`);
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  };
  const gateway = createBaseSolanaGateway({ rpcUrl: 'https://rpc.example', genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash, maximumSponsorLamports: '10000000' }, fetcher);
  const expected = [{ account: source.address, mint: mint.address, owner: actor.address, direction: 'debit' as const, minimumAtomic: '100', maximumAtomic: '100' },
    { account: destination.address, mint: mint.address, owner: actor.address, direction: 'credit' as const, minimumAtomic: '100', maximumAtomic: '100' }];
  return { gateway, bytes, sponsor, actor, source, destination, mint, expected, calls, index, accountKeys,
    setCredit: (value: bigint) => { credit = value; }, setOwner: (value: typeof owner) => { owner = value; },
    setGenesis: (value: string) => { genesis = value; }, setMutation: (change: (value: SimulationValue) => void) => { mutate = change; } };
}

test('base gateway preserves finalized lifetime and distinguishes confirmed block-height observations', async () => {
  const f = await fixture();
  assert.deepEqual(await f.gateway.lifetime(), { blockhash: SOLANA_IDS.system, lastValidBlockHeight: '100', blockHeight: '10' });
  assert.equal(await f.gateway.blockHeight('confirmed'), '12');
  assert.equal(await f.gateway.blockHeight('finalized'), '10');
  f.setGenesis('wrong-network');
  await assert.rejects(f.gateway.lifetime(), /genesis mismatch/);
  await assert.rejects(f.gateway.blockHeight('confirmed'), /genesis mismatch/);
});

test('one exact finalized simulation supplies atomic native, token and fee evidence without bank sampling', async () => {
  const f = await fixture();
  assert.deepEqual(await f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected),
    { slot: '10', sponsorDebitCeilingLamports: '20000', networkFeeLamports: '10000' });
  assert.deepEqual(f.calls, ['simulateTransaction']);
  assert.equal((await f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address)).sponsorDebitCeilingLamports, '20000');
});

test('atomic deltas refuse smaller credit, larger debit and wrong pre/post owner, mint or token program', async () => {
  const f = await fixture();
  f.setCredit(99n);
  await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected), /delta differs/);
  f.setCredit(100n); f.setOwner(f.sponsor.address);
  await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected), /owner or mint/);
  f.setOwner(f.actor.address);
  for (const change of [
    (v: SimulationValue) => { v.preTokenBalances[0].uiTokenAmount.amount = '1001'; },
    (v: SimulationValue) => { v.preTokenBalances[0].owner = f.sponsor.address; },
    (v: SimulationValue) => { v.preTokenBalances[0].mint = f.sponsor.address; },
    (v: SimulationValue) => { v.preTokenBalances[0].programId = SOLANA_IDS.system; },
    (v: SimulationValue) => { v.postTokenBalances[0].mint = f.sponsor.address; },
    (v: SimulationValue) => { v.postTokenBalances[0].programId = SOLANA_IDS.system; },
  ]) {
    f.setMutation(change);
    await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected), /delta differs|owner or mint/);
  }
});

test('simulation rejects an unreviewed protected-owner token loss', async () => {
  const f = await fixture();
  await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, [f.expected[1]]), /Unexpected simulated token loss/);
});

test('native actor debit and sponsor debit plus fee ceilings remain conservative', async () => {
  const f = await fixture();
  f.setMutation(value => { value.postBalances[f.index.actor]--; });
  await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected), /user would pay native fees/);
  f.setMutation(() => {}); f.gateway.config.maximumSponsorLamports = '19999';
  await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected), /fee and rent ceiling/);
  f.gateway.config.maximumSponsorLamports = '20000';
  assert.equal((await f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected)).sponsorDebitCeilingLamports, '20000');
  f.setMutation(value => { value.fee = 10001; });
  await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected), /fee and rent ceiling/);
});

test('missing or malformed atomic evidence never falls back to another bank or guessed balances', async () => {
  const f = await fixture();
  for (const change of [
    (v: SimulationValue) => { delete (v as Partial<SimulationValue>).preBalances; },
    (v: SimulationValue) => { v.postBalances.pop(); },
    (v: SimulationValue) => { v.preBalances[0] = Number.MAX_SAFE_INTEGER + 1; },
    (v: SimulationValue) => { v.fee = null; },
    (v: SimulationValue) => { delete (v as Partial<SimulationValue>).preTokenBalances; },
    (v: SimulationValue) => { delete (v as Partial<SimulationValue>).postTokenBalances; },
    (v: SimulationValue) => { v.preTokenBalances.push(v.preTokenBalances[0]); },
    (v: SimulationValue) => { v.preTokenBalances[0].accountIndex = f.accountKeys.length; },
    (v: SimulationValue) => { v.preTokenBalances[0].accountIndex = 0.5; },
    (v: SimulationValue) => { delete v.preTokenBalances[0].owner; },
    (v: SimulationValue) => { delete v.preTokenBalances[0].programId; },
    (v: SimulationValue) => { v.preTokenBalances[0].uiTokenAmount.amount = '1.5'; },
    (v: SimulationValue) => { v.preTokenBalances[0].uiTokenAmount.amount = '18446744073709551616'; },
    (v: SimulationValue) => { v.preTokenBalances[0].uiTokenAmount.decimals = 256; },
    (v: SimulationValue) => { v.loadedAddresses.writable.push(f.source.address); },
    (v: SimulationValue) => { v.accounts[0]!.lamports--; },
    (v: SimulationValue) => { v.postTokenBalances[0].uiTokenAmount.amount = '899'; },
    (v: SimulationValue) => { v.preTokenBalances[0].uiTokenAmount.decimals = 7; },
  ]) {
    f.setMutation(change);
    await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected));
  }
  assert.ok(f.calls.every(method => method === 'simulateTransaction'));
});

test('frozen, uninitialized or executable post-token accounts and failed simulations are refused', async () => {
  const f = await fixture();
  for (const state of [0, 2]) {
    f.setMutation(value => {
      const row = value.accounts.find(item => item?.data[0] && Buffer.from(item.data[0], 'base64').length === 165)!;
      const data = Buffer.from(row.data[0], 'base64'); data[108] = state; row.data[0] = data.toString('base64');
    });
    await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected), /owner or mint/);
  }
  f.setMutation(value => { value.accounts.find(item => item?.data[0] && Buffer.from(item.data[0], 'base64').length === 165)!.executable = true; });
  await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected), /wrong program owner/);
  f.setMutation(value => { value.err = { InstructionError: [0, { Custom: 17 }] }; });
  await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected), /Exact transaction simulation failed/);
});

test('creation and closure require their explicit reviewed exceptions and complete account evidence', async () => {
  const f = await fixture();
  f.setMutation(value => { value.preTokenBalances = value.preTokenBalances.filter(row => row.accountIndex !== f.index.destination); value.preBalances[f.index.destination] = 0; });
  await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, f.expected), /Missing simulated token balance/);
  assert.equal((await f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, [f.expected[0], { ...f.expected[1], allowCreated: true }])).slot, '10');
  f.setCredit(1000n);
  f.setMutation(value => {
    value.postTokenBalances = value.postTokenBalances.filter(row => row.accountIndex !== f.index.source);
    const sourceToken = value.accounts.findIndex(row => {
      if (!row?.data[0]) return false;
      const data = Buffer.from(row.data[0], 'base64');
      return data.length === 165 && data.readBigUInt64LE(64) === 900n;
    });
    value.accounts[sourceToken] = null; value.postBalances[f.index.source] = 0;
  });
  const closed = [{ ...f.expected[0], minimumAtomic: '1000', maximumAtomic: '1000', allowClosed: true }, { ...f.expected[1], minimumAtomic: '1000', maximumAtomic: '1000' }];
  assert.equal((await f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, closed)).slot, '10');
  await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, [{ ...closed[0], allowClosed: false }, closed[1]]), /Missing simulated token balance/);
});

test('duplicate expectations and non-writable recipients remain refused', async () => {
  const f = await fixture();
  await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, [f.expected[0], f.expected[0]]), /Duplicate simulated token expectation/);
  await assert.rejects(f.gateway.simulate(f.bytes, f.sponsor.address, f.actor.address, [{ ...f.expected[0], account: f.actor.address }]), /not writable/);
});
