import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from './store.ts';
import { createListing, listListings } from './listings.ts';
import { SHARE_ORACLE, SHARE_STOCK } from '../domain/deposit-form.ts';
import type { VerifiedIdentity } from '../wallets/identity-policy.ts';

const landlord: VerifiedIdentity = {
  subject: 'deposit-cap-landlord', sessionId: 'deposit-cap-session', expiresAt: Date.now() / 1000 + 3600,
  passkeyCount: 1,
  wallets: [
    { id: 'cash-wallet', address: 'cash-address', chainType: 'solana' },
    { id: 'share-wallet', address: '0x1111111111111111111111111111111111111111', chainType: 'ethereum' },
  ],
};

test('publication caps cash at three months and shares at two in six-decimal rent/security units', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'listing-deposit-cap-'));
  const previousManifest = process.env.SHARE_DEPOSIT_MANIFEST_FILE;
  const manifest = join(directory, 'manifest.json');
  const store = new LocalStore(':memory:');
  try {
    await writeFile(manifest, JSON.stringify({
      chainId: 46630, status: 'deployed', stock: SHARE_STOCK, oracle: SHARE_ORACLE,
      factory: '0x2222222222222222222222222222222222222222',
      implementation: '0x3333333333333333333333333333333333333333',
      factoryCodeHash: `0x${'a'.repeat(64)}`, implementationCodeHash: `0x${'b'.repeat(64)}`,
    }));
    process.env.SHARE_DEPOSIT_MANIFEST_FILE = manifest;
    for (const kind of ['cash', 'shares'] as const) {
      // 900.123456 test dollars; security is USD6, not TSLA's 18-decimal quantity.
      const security = kind === 'shares' ? '1800246912' : '2700370368';
      const input = { title: `${kind} boundary home`, rentMonthly: '900123456', requiredSecurity: security, releaseAllowed: true, depositForm: kind };
      const accepted = await createListing(store, landlord, input);
      assert.equal(accepted.rentMonthly, '900123456');
      assert.equal(accepted.requiredSecurity, security);
      if (accepted.depositForm?.kind === 'shares') assert.equal(accepted.depositForm.securityUsd6, security);
      await assert.rejects(() => createListing(store, landlord, { ...input, requiredSecurity: String(BigInt(security) + 1n) }),
        kind === 'shares' ? /share-backed security.*two months.*150%.*§551\(1\) BGB/ : /cash deposit.*three months.*§551\(1\) BGB/);
    }
    await assert.rejects(() => createListing(store, landlord, { title: 'Legacy cash input', rentMonthly: '1000000', requiredSecurity: '3000001', releaseAllowed: false }), /cash deposit.*three months/);
    const cash = (await listListings(store, landlord)).find(home => home.depositForm?.kind === 'cash')!;
    await store.update<{ requiredSecurity: string }>(`listing:${cash.id}`, value => ({ ...value, requiredSecurity: '9000000000' }));
    assert.equal((await listListings(store, landlord)).find(home => home.id === cash.id)?.requiredSecurity, '9000000000', 'existing listings are not retroactively capped');
    assert.equal((await listListings(store, landlord)).length, 2, 'rejected publications were not stored');
  } finally {
    if (previousManifest === undefined) delete process.env.SHARE_DEPOSIT_MANIFEST_FILE;
    else process.env.SHARE_DEPOSIT_MANIFEST_FILE = previousManifest;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
