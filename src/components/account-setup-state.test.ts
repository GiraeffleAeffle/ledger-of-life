import test from 'node:test';
import assert from 'node:assert/strict';
import { accountSetupStep } from './account-setup-state.ts';

const both = [{ chainType: 'solana' }, { chainType: 'ethereum' }];
const signedIn = { ready: true, authenticated: true, subject: 'alice', passkeyCount: 1, wallets: both };

test('a passkey-only account with both wallets is ready', () => {
  assert.equal(accountSetupStep(signedIn), 'done');
});

test('sign-in and a passkey precede wallet creation', () => {
  assert.equal(accountSetupStep({ ...signedIn, authenticated: false, subject: null, wallets: [] }), 'account');
  assert.equal(accountSetupStep({ ...signedIn, passkeyCount: 0, wallets: [] }), 'account');
  assert.equal(accountSetupStep({ ...signedIn, wallets: [] }), 'wallets');
  assert.equal(accountSetupStep({ ...signedIn, wallets: [{ chainType: 'solana' }] }), 'wallets');
  assert.equal(accountSetupStep({ ...signedIn, wallets: [{ chainType: 'ethereum' }] }), 'wallets');
});


test('setup waits until the wallet SDK has answered', () => {
  assert.equal(accountSetupStep({ ...signedIn, ready: false, authenticated: false, subject: null }), 'loading');
});
