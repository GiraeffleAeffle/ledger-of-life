import test from 'node:test';
import assert from 'node:assert/strict';
import { accountSetupStep } from './account-setup-state.ts';

const both = [{ chainType: 'solana' }, { chainType: 'ethereum' }];
const signedIn = { ready: true, authenticated: true, subject: 'alice', passkeyCount: 1, backupLoginLinked: true, wallets: both, recoveryRequired: true };

test('setup is finished once passkey, backup email and both wallets exist, whatever the recovery state', () => {
  assert.equal(accountSetupStep(signedIn), 'done');
});

test('a person moves through account, backup and wallets in that order', () => {
  assert.equal(accountSetupStep({ ...signedIn, authenticated: false, subject: null, wallets: [] }), 'account');
  assert.equal(accountSetupStep({ ...signedIn, passkeyCount: 0, wallets: [] }), 'account');
  assert.equal(accountSetupStep({ ...signedIn, backupLoginLinked: false, wallets: [] }), 'backup');
  assert.equal(accountSetupStep({ ...signedIn, wallets: [] }), 'wallets');
  assert.equal(accountSetupStep({ ...signedIn, wallets: [{ chainType: 'solana' }] }), 'wallets');
  assert.equal(accountSetupStep({ ...signedIn, wallets: [{ chainType: 'ethereum' }] }), 'wallets');
});

test('a demo build that skips recovery also skips the backup email', () => {
  assert.equal(accountSetupStep({ ...signedIn, recoveryRequired: false, backupLoginLinked: false }), 'done');
});

test('nothing is shown as "to do" until the wallet SDK and the server have both answered', () => {
  assert.equal(accountSetupStep({ ...signedIn, ready: false, authenticated: false, subject: null }), 'loading');
  assert.equal(accountSetupStep({ ...signedIn, recoveryRequired: null }), 'loading');
});
