import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { generateKeyPairSigner } from '@solana/kit';
import { SHARES_PRICE_AUTHORITY } from '../finance/solana/shares.ts';
import { LocalStore } from './store.ts';
import { solanaSharesConfiguration } from './solana-shares-config.ts';
import { configuredSolanaOperations } from './solana-operations.ts';
import { assertTestSignerAllowed, signPrepared, testIdentity } from './test-signer.ts';
import { mintTestUsdc } from './test-usdc.ts';
import { prepareSolanaMarketAction, submitSolanaMarketAction, prepareSolanaSharesFaucet, submitSolanaSharesFaucet, readSolanaSharedMarket, type SolanaMarketAction } from './shared-market-solana.ts';

/** Operator fixture, not Privy evidence. Uses only the configured site's sponsor.
 * Run after launch gate with SOLANA_LENDING_DEVNET_PROOF=1, SOLANA_TEST_SIGNER_MODE=1,
 * deployed SOLANA_SHARES_MANIFEST and existing server env. No key files are read here.
 * Consumes one real share faucet claim and one site tUSDC claim. Prints exact reviews
 * before signatures and finalized Explorer receipts; all assets are fictional. */
test('devnet: faucet, lend, collateral, borrow, repay and withdraw', { skip: process.env.SOLANA_LENDING_DEVNET_PROOF !== '1', timeout: 600_000 }, async () => {
  const manifest = await solanaSharesConfiguration();
  assert.ok(manifest, 'Deployed shares manifest required.');
  assertTestSignerAllowed(process.env, manifest);
  assert.equal(manifest.cluster, 'devnet');
  const store = new LocalStore(':memory:');
  try {
    const { operations, sponsor } = await configuredSolanaOperations(store, { cluster: 'devnet', genesisHash: manifest.genesisHash, maximumSponsorLamports: 10_000_000n });
    assert.equal(sponsor.address, SHARES_PRICE_AUTHORITY, 'Local sponsor differs: defer to hosted release; never swap keys.');
    const signer = await generateKeyPairSigner();
    const identity = testIdentity('tenant', signer.address);
    const options = { manifest, operations, sponsorAddress: sponsor.address };
    const receipts: { action: string; signature: string; explorerUrl: string }[] = [];
    const finalize = async (id: string, action: string) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        const result = await operations.reconcile({ identity, id });
        if (result.state === 'confirmed') {
          assert.ok(result.signature);
          const receipt = { action, signature: result.signature, explorerUrl: `https://explorer.solana.com/tx/${result.signature}?cluster=devnet` };
          receipts.push(receipt); console.log(JSON.stringify(receipt)); return;
        }
        if (result.state === 'failed' || result.state === 'expired') throw new Error(`${action}: ${result.state}`);
        await delay(2000);
      }
      throw new Error(`${action} remains pending; retain immutable signed bytes, do not replace the transaction.`);
    };
    console.log(JSON.stringify({ phase: 'exact-review-before-signature', action: 'site-cash-faucet', network: 'solana-devnet', recipient: signer.address, feePayer: sponsor.address, amountAtomic: (BigInt(process.env.SOLANA_TEST_USDC_AMOUNT ?? '10000') * 1_000_000n).toString(), mint: manifest.cashMint, effect: 'Mint fictional site tUSDC to the ephemeral fixture wallet; no monetary value.' }));
    const cash = await mintTestUsdc(store, identity.subject, signer.address);
    assert.equal(cash.status, 'confirmed', 'Site cash faucet must finalize before lending.');
    const faucet = await prepareSolanaSharesFaucet(store, identity, { requestId: randomUUID() }, options);
    console.log(JSON.stringify({ phase: 'exact-review-before-signature', action: 'share-faucet', feePayer: sponsor.address, review: faucet.review }));
    await submitSolanaSharesFaucet(store, identity, faucet.id, await signPrepared(signer, faucet.transactionBase64), options);
    assert.ok('signature' in cash && cash.signature);
    receipts.push({ action: 'site-cash-faucet', signature: cash.signature, explorerUrl: `https://explorer.solana.com/tx/${cash.signature}?cluster=devnet` });
    await finalize(faucet.id, 'share-faucet');
    const act = async (operation: SolanaMarketAction, quantity: string) => {
      const plan = await prepareSolanaMarketAction(store, identity, { operation, quantity, requestId: randomUUID() }, options);
      console.log(JSON.stringify({ phase: 'exact-review-before-signature', action: operation, feePayer: sponsor.address, review: plan.review }));
      await submitSolanaMarketAction(store, identity, plan.id, await signPrepared(signer, plan.transactionBase64), options);
      await finalize(plan.id, operation);
    };
    await act('lend', '10000000');
    await act('deposit_collateral', '1000000');
    await act('borrow', '1000000');
    let view = await readSolanaSharedMarket(store, identity, options);
    assert.equal(view.loan.sharesRaw, '1000000');
    assert.ok(BigInt(view.loan.debtAtomic) >= 1_000_000n);
    await act('repay', '2000000');
    view = await readSolanaSharedMarket(store, identity, options);
    assert.equal(view.loan.debtAtomic, '0');
    await act('withdraw_collateral', '1000000');
    await act('unlend', '1000000');
    view = await readSolanaSharedMarket(store, identity, options);
    assert.equal(view.loan.sharesRaw, '0');
    assert.equal(view.loan.debtAtomic, '0');
    console.log(JSON.stringify({ evidenceKind: 'ephemeral-test-signer-devnet-not-privy', network: 'solana-devnet', actor: signer.address, feePayer: sponsor.address, programId: manifest.programId, pool: manifest.pool, receipts, final: view, note: 'Actual sponsored devnet fixture only, not Privy proof. Test assets have no value. One tUSDC was withdrawn; remaining lender entitlement is disclosed in final state.' }, null, 2));
  } finally { await store.close(); }
});
