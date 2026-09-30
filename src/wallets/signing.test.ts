import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from '@solana/kit';
import { verifyTypedData, zeroHash } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  assertUnchangedSolanaMessage,
  privyTransaction,
  validateEvmSigningRequest,
  validateSolanaSigningRequest,
} from './signing-policy.ts';
import { prepareEscrowTypedData, type EscrowSigningRequest } from './escrow-signing.ts';
import type { EvmSigningRequest, RentalWallet, SolanaSigningRequest } from './types.ts';

const now = Date.parse('2026-09-22T19:00:00.000Z');
const review = {
  operationId: 'operation-test',
  description: 'Release 10 USDC of eligible earnings.',
  expiresAt: '2026-09-22T20:00:00.000Z',
};
const solanaAddress = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const sponsor = address('XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W');
const wallet: RentalWallet = {
  id: 'wallet-solana',
  address: solanaAddress,
  chainType: 'solana',
  connected: true,
};

function encodedTransaction(feePayer: Address = sponsor, signer: Address = solanaAddress) {
  const transaction = pipe(
    createTransactionMessage({ version: 0 }),
    (message) => setTransactionMessageFeePayer(feePayer, message),
    (message) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 100n },
        message,
      ),
    (message) =>
      appendTransactionMessageInstruction(
        {
          programAddress: address('11111111111111111111111111111111'),
          accounts: [{ address: signer, role: AccountRole.READONLY_SIGNER }],
          data: new Uint8Array([0, 1, 2, 3]),
        },
        message,
      ),
    compileTransaction,
  );
  return new Uint8Array(getTransactionEncoder().encode(transaction));
}

test('Solana requests preserve the declared sponsor and require the selected wallet signature', () => {
  const request: SolanaSigningRequest = {
    ...review,
    walletId: wallet.id,
    chain: 'solana:devnet',
    feePayer: sponsor,
    transaction: encodedTransaction(),
  };
  const validated = validateSolanaSigningRequest(request, wallet, now);
  assert.equal(validated.wallet.address, solanaAddress);
  assert.doesNotThrow(() =>
    assertUnchangedSolanaMessage(new Uint8Array(validated.messageBytes), request.transaction),
  );
  assert.throws(
    () => validateSolanaSigningRequest({ ...request, feePayer: solanaAddress }, wallet, now),
    /separate fee sponsor/,
  );
  assert.throws(
    () =>
      validateSolanaSigningRequest(
        { ...request, transaction: encodedTransaction(solanaAddress) },
        wallet,
        now,
      ),
    /does not match/,
  );
  assert.throws(
    () =>
      validateSolanaSigningRequest(
        { ...request, transaction: encodedTransaction(sponsor, sponsor) },
        wallet,
        now,
      ),
    /another wallet/,
  );
  const changed = request.transaction.slice();
  changed[changed.length - 1] ^= 1;
  assert.throws(
    () => assertUnchangedSolanaMessage(new Uint8Array(validated.messageBytes), changed),
    /differs/,
  );
});

test('signing rejects expired requests and an unsupported EVM chain or substituted owner', () => {
  const evmWallet: RentalWallet = {
    id: 'wallet-evm',
    address: '0x1111111111111111111111111111111111111111',
    chainType: 'ethereum',
    connected: true,
  };
  const request: EvmSigningRequest = {
    ...review,
    walletId: evmWallet.id,
    transaction: { chainId: 4663, to: '0x2222222222222222222222222222222222222222' },
  };
  assert.doesNotThrow(() => validateEvmSigningRequest(request, evmWallet, now));
  assert.throws(
    () => validateEvmSigningRequest(request, evmWallet, Date.parse(review.expiresAt)),
    /expired/,
  );
  assert.throws(
    () =>
      validateEvmSigningRequest(
        { ...request, transaction: { ...request.transaction, chainId: 1 as 4663 } },
        evmWallet,
        now,
      ),
    /Robinhood/,
  );
  assert.throws(
    () =>
      validateEvmSigningRequest(
        { ...request, transaction: { ...request.transaction, from: request.transaction.to } },
        evmWallet,
        now,
      ),
    /another wallet/,
  );
});

test('the bounded escrow signature binds action, chain and contract', async () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const evmWallet: RentalWallet = {
    id: 'wallet-evm',
    address: signer.address,
    chainType: 'ethereum',
    connected: true,
  };
  const request: EscrowSigningRequest = {
    ...review,
    walletId: evmWallet.id,
    chainId: 4663,
    escrowAddress: '0x2222222222222222222222222222222222222222',
    action: {
      signer: signer.address,
      kind: 3,
      amount: '10000000',
      limit: '10000000000000000000',
      evidence: zeroHash,
      expectedNonce: '7',
      deadline: String(Math.floor(Date.parse(review.expiresAt) / 1000)),
    },
  };
  const typedData = prepareEscrowTypedData(request, evmWallet, now);
  const signature = await signer.signTypedData(typedData);
  assert.equal(await verifyTypedData({ ...typedData, address: signer.address, signature }), true);
  assert.equal(
    await verifyTypedData({
      ...typedData,
      message: { ...typedData.message, amount: '20000000' },
      address: signer.address,
      signature,
    }),
    false,
  );
  assert.equal(
    await verifyTypedData({
      ...typedData,
      domain: { ...typedData.domain, chainId: 46630 },
      address: signer.address,
      signature,
    }),
    false,
  );
  assert.equal(
    await verifyTypedData({
      ...typedData,
      domain: {
        ...typedData.domain,
        verifyingContract: '0x3333333333333333333333333333333333333333',
      },
      address: signer.address,
      signature,
    }),
    false,
  );
  assert.throws(
    () =>
      prepareEscrowTypedData(
        { ...request, action: { ...request.action, kind: 1 } },
        evmWallet,
        now,
      ),
    /Unexpected action amount/,
  );
  assert.throws(
    () =>
      prepareEscrowTypedData(
        { ...request, action: { ...request.action, deadline: '9999999999' } },
        evmWallet,
        now,
      ),
    /Refresh/,
  );
});

test('a prepared gas limit reaches Privy as gasLimit, so the signed transaction keeps the reviewed limit', () => {
  const prepared = { chainId: 46630 as const, to: '0xA6e10E426A738aEF586dB5191177658D67C78A14', data: '0x40c10f19' as const, nonce: 3, gas: '0x1d4c0', maxFeePerGas: '0x989680' };
  const forPrivy = privyTransaction(prepared);
  assert.equal(forPrivy.gasLimit, '0x1d4c0');
  assert.equal('gas' in forPrivy, false);
  assert.equal(forPrivy.nonce, 3);
  assert.deepEqual(privyTransaction({ ...prepared, gasLimit: '120000' }).gasLimit, '120000');
  assert.throws(() => privyTransaction({ ...prepared, gasLimit: '0x1' }), /two different gas limits/);
  assert.equal(privyTransaction({ ...prepared, gas: undefined }).gasLimit, undefined);
});
