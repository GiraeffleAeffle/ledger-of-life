import assert from 'node:assert/strict';
import test from 'node:test';
import { createSolanaWalletLookup } from './identity-solana-wallet.ts';
import type { IdentityVerificationDependencies } from '../wallets/identity-policy.ts';
const subject = 'did:privy:host-owner';
const address = 'HEZ9ERxb1W9WfBjUGE6A4jFZU3jUMJRSM1kyERgac38G';
function fixture() {
  let now = 100_000, reads = 0, failing = false;
  const user = { id: subject, linked_accounts: [{ type: 'wallet', id: 'sol-wallet', address, chain_type: 'solana', wallet_client_type: 'privy-v2', connector_type: 'embedded' }] };
  const wallet = { id: 'sol-wallet', address, chain_type: 'solana', owner_id: subject, additional_signers: [] as unknown[] };
  const quorum = { id: 'quorum', user_ids: [subject], authorization_keys: [], authorization_threshold: 1 };
  const dependencies: IdentityVerificationDependencies = { appId: 'app', now: () => now,
    verifyToken: async () => { throw new Error('No user token in server lookup'); },
    getUser: async () => { reads++; if (failing) throw new Error('Provider unavailable'); return user; },
    getWallet: async () => wallet, getOwner: async () => quorum, isValidAddress: () => true };
  return { user, wallet, quorum, dependencies, lookup: createSolanaWalletLookup(dependencies), reads: () => reads,
    advance: () => { now += 121_000; }, fail: (value: boolean) => { failing = value; } };
}
test('host payout lookup rejects owner mismatch and multi-user quorum', async () => {
  const f = fixture(); f.wallet.owner_id = 'quorum'; f.quorum.user_ids = ['did:privy:other'];
  assert.equal(await f.lookup(subject), null);
  f.quorum.user_ids = [subject, 'did:privy:other'];
  assert.equal(await f.lookup(subject), null);
});
test('host payout lookup returns null for EVM-only user', async () => {
  const f = fixture(); f.user.linked_accounts[0].chain_type = 'ethereum'; f.wallet.chain_type = 'ethereum';
  assert.equal(await f.lookup(subject), null);
});
test('host payout lookup refuses ambiguous several eligible Solana wallets', async () => {
  const f = fixture();
  f.user.linked_accounts.push({ ...f.user.linked_accounts[0], id: 'other-wallet' });
  const lookup = createSolanaWalletLookup({ ...f.dependencies, getWallet: async id => ({ ...f.wallet, id }) });
  assert.equal(await lookup(subject), null);
});
test('host payout lookup accepts exclusive user quorum and caches only public wallet briefly', async () => {
  const f = fixture(); f.wallet.owner_id = 'quorum';
  assert.deepEqual(await f.lookup(subject), { id: 'sol-wallet', address });
  assert.deepEqual(await f.lookup(subject), { id: 'sol-wallet', address });
  assert.equal(f.reads(), 1);
  f.advance(); await f.lookup(subject); assert.equal(f.reads(), 2);
});
test('provider errors propagate and never become a permanent no-wallet result', async () => {
  const f = fixture(); f.fail(true); await assert.rejects(f.lookup(subject), /temporarily unavailable/);
  f.fail(false); assert.deepEqual(await f.lookup(subject), { id: 'sol-wallet', address }); assert.equal(f.reads(), 2);
});
