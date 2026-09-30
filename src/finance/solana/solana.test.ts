import assert from "node:assert/strict";
import test from "node:test";
import { AccountRole, address, appendTransactionMessageInstruction, blockhash, compileTransaction, createTransactionMessage, getAddressDecoder, getAddressEncoder, getBase58Decoder, getTransactionEncoder, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/kit";
import {
  atomic, receiptValue, releasableEarnings, scaledExposure, SOLANA_IDS, SOLANA_DEVNET_MANIFEST, SOLANA_MAINNET_MANIFEST,
  resolveSolanaManifest, deriveKaminoAddresses, deriveEscrowAddresses, buildEscrowInstruction, decodeTenancy,
  decodeKaminoReserve, validateMintObservation, quoteInvestment, parseJupiterQuote, validateQuoteForAuthorization,
  reconcileSolanaSignature, inspectMetisRoute, type DeploymentManifest, type TenancyAccount, type JupiterQuote,
  inspectInvestmentTransaction, messageDigest, observeSolanaSignature,
  SOLANA_TEST_USDC_MINT, ledgerDepositMint,
} from "./index.ts";
const key = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
const tenant = key(1), landlord = key(2), arbitrator = key(3), sponsor = key(4), inputAccount = key(5), outputAccount = key(6);
const program = key(10), reserve = key(11), market = key(12);
const pair = { inputMint: SOLANA_MAINNET_MANIFEST.deposit.mint, outputMint: SOLANA_MAINNET_MANIFEST.investment.mint };
const manifest: DeploymentManifest = {
  cluster: "devnet", genesisHash: SOLANA_DEVNET_MANIFEST.genesisHash, escrowProgram: program,
  programSha256: "a".repeat(64), depositMint: SOLANA_DEVNET_MANIFEST.deposit.mint, market, reserve,
  receiptMint: key(13), liquiditySupply: key(14), marketAuthority: key(15), oracleAccounts: [], maxObservationAgeMs: 15_000,
};
const request = { direction: "buy" as const, inputAtomic: "10000000", genesisHash: SOLANA_MAINNET_MANIFEST.genesisHash, nowMs: 100_000 };
const response = { ...pair, inAmount: "10000000", outAmount: "1283122", requestId: "fixture-request", router: "metis", feeBps: 10, feeMint: pair.inputMint, transaction: null, lastValidBlockHeight: "99" };

test("atomic balances preserve precision and reject ambiguous amounts", () => {
  assert.equal(atomic("18446744073709551615"), (1n << 64n) - 1n);
  for (const value of [1, "1.2", "01", "-1", "1e9", "18446744073709551616"]) assert.throws(() => atomic(value));
  assert.equal(receiptValue("3000000000", "120000000000000", (124000000000000n << 60n).toString()), "3100000000");
  assert.equal(receiptValue("1", "3", (1n << 60n).toString()), "0");
});
test("only cash surplus can leave an active, permitted, fresh tenancy", () => {
  const input = { idleAtomic: "10000000", receiptValueAtomic: "3000000000", requiredSecurityAtomic: "3000000000", policyPermits: true, phase: "active", valuationFresh: true };
  assert.equal(releasableEarnings(input).availableAtomic, "10000000");
  assert.equal(releasableEarnings({ ...input, idleAtomic: "0", receiptValueAtomic: "3010000000" }).availableAtomic, "0");
  assert.equal(releasableEarnings({ ...input, policyPermits: false }).availableAtomic, "0");
  assert.equal(releasableEarnings({ ...input, phase: "disputed" }).availableAtomic, "0");
  assert.equal(releasableEarnings({ ...input, valuationFresh: false }).reason, "stale-valuation");
  assert.equal(releasableEarnings({ ...input, receiptValueAtomic: "2989999999" }).reason, "security-shortfall");
});
test("scaled economic exposure does not manufacture cash or raw tokens", () => {
  assert.equal(scaledExposure("100000000", 8, "1.005714560286254"), "1.00571456");
  assert.equal(atomic("100000000"), 100000000n);
  assert.throws(() => scaledExposure("100000000", 8, "0"));
});
test("deployment remains explicitly gated by test mint and genesis identity", () => {
  assert.deepEqual(resolveSolanaManifest({ cluster: "devnet", genesisHash: manifest.genesisHash }), { available: false, reason: "escrow-deployment-not-configured" });
  assert.equal(resolveSolanaManifest({ cluster: "devnet", genesisHash: "wrong", deployment: manifest }).available, false);
  assert.equal(resolveSolanaManifest({ cluster: "mainnet-beta", genesisHash: SOLANA_MAINNET_MANIFEST.genesisHash }).available, false);
  assert.equal(resolveSolanaManifest({ cluster: "devnet", genesisHash: manifest.genesisHash, deployment: manifest }).available, true);
  assert.equal(resolveSolanaManifest({ cluster: "devnet", genesisHash: manifest.genesisHash, deployment: { ...manifest, depositMint: pair.inputMint } }).available, false);
});
test("only the site mint may select cash-only new deposits", () => {
  const selected = { ...manifest, ledgerDepositMint: SOLANA_TEST_USDC_MINT };
  assert.equal(resolveSolanaManifest({ cluster: "devnet", genesisHash: manifest.genesisHash, deployment: selected }).available, true);
  assert.equal(ledgerDepositMint(selected), SOLANA_TEST_USDC_MINT);
  assert.equal(ledgerDepositMint(manifest), SOLANA_DEVNET_MANIFEST.deposit.mint);
  for (const mint of [manifest.depositMint, pair.inputMint, key(99), ""]) {
    assert.equal(resolveSolanaManifest({ cluster: "devnet", genesisHash: manifest.genesisHash, deployment: { ...manifest, ledgerDepositMint: mint } }).available, false);
  }
});
test("reserve decoder validates owner, discriminator, exact pinned layout and all fee buckets", () => {
  const data = new Uint8Array(8624); data.set([43, 242, 204, 202, 26, 247, 59, 127]); const view = new DataView(data.buffer);
  view.setBigUint64(224, 100n, true); view.setBigUint64(232, 10n << 60n, true);
  for (const [offset, amount] of [[344, 2n], [360, 3n], [376, 1n]] as const) view.setBigUint64(offset, amount << 60n, true);
  const account = { address: reserve, owner: SOLANA_IDS.klend, executable: false, data };
  assert.equal(decodeKaminoReserve(account).netLiquidityScaled, (104n << 60n).toString());
  const nullOracle = "nu11111111111111111111111111111111111111111";
  data.set(getAddressEncoder().encode(address(nullOracle)), 5112);
  data.set(getAddressEncoder().encode(address(nullOracle)), 5160);
  data.set(getAddressEncoder().encode(address(nullOracle)), 5192);
  data.set(getAddressEncoder().encode(address(inputAccount)), 5224);
  assert.deepEqual(decodeKaminoReserve(account).oracleAccounts, [inputAccount]);
  assert.throws(() => decodeKaminoReserve({ ...account, owner: program }));
  assert.throws(() => decodeKaminoReserve({ ...account, data: data.slice(0, -1) }));
  data[0] = 0; assert.throws(() => decodeKaminoReserve(account));
});
test("issuer powers need explicit review and cannot be confused with escrow permissions", () => {
  const observed = { address: pair.outputMint, owner: SOLANA_IDS.token2022, decimals: 8, initialized: true, supplyAtomic: "100000000", extensions: ["scaledUiAmountConfig", "permanentDelegate"], permanentDelegate: key(20), scaledUiMultiplier: "1.0057" };
  const expected = { mint: pair.outputMint, tokenProgram: SOLANA_IDS.token2022, decimals: 8 };
  assert.throws(() => validateMintObservation(observed, expected));
  const reviewed = { ...expected, approvedExtensions: observed.extensions, approvedPermanentDelegate: key(20) };
  assert.equal(validateMintObservation(observed, reviewed), observed);
  assert.throws(() => validateMintObservation({ ...observed, permanentDelegate: key(21) }, reviewed));
  assert.throws(() => validateMintObservation({ ...observed, paused: true }, reviewed));
  assert.throws(() => validateMintObservation({ ...observed, transferHookProgram: key(22) }, reviewed));
});
async function tenancyFixture(): Promise<TenancyAccount> {
  const leaseId = new Uint8Array(32).fill(1); const derived = await deriveEscrowAddresses(program, tenant, leaseId);
  return { address: derived.tenancy, leaseId, tenant, landlord, arbitrator, depositMint: manifest.depositMint, reserve, market, receiptMint: manifest.receiptMint, liquiditySupply: manifest.liquiditySupply, marketAuthority: manifest.marketAuthority, tenantDestination: inputAccount, landlordDestination: key(23), policyHash: new Uint8Array(32).fill(2), releasePermitted: true, requiredSecurityAtomic: "3000000000", accountedIdleAtomic: "3010000000", accountedReceiptsAtomic: "0", releasedEarningsAtomic: "0", nextNonce: "4", claimAtomic: "0", approvedClaimAtomic: "0", phase: "active", bump: derived.bump, tenantOwedAtomic: "0", landlordOwedAtomic: "0" };
}
test("instruction planner pins PDAs, nonce and tenant recipient", async () => {
  const tenancy = await tenancyFixture();
  const ix = await buildEscrowInstruction({ manifest, tenancy, actor: tenant, nonce: "4", action: { kind: "release_earnings", amountAtomic: "10000000" } });
  assert.equal(ix.accounts![6].address, inputAccount);
  assert.deepEqual([...ix.data!.slice(0, 8)], [133, 153, 190, 61, 65, 103, 225, 72]);
  const bytes = new Uint8Array(ix.data!);assert.equal(new DataView(bytes.buffer).getBigUint64(8, true), 10_000_000n);
  await assert.rejects(buildEscrowInstruction({ manifest, tenancy, actor: tenant, nonce: "3", action: { kind: "settle" } }));
  await assert.rejects(buildEscrowInstruction({ manifest, tenancy: { ...tenancy, address: key(24) }, actor: tenant, nonce: "4", action: { kind: "settle" } }));
  const newReserve = await deriveKaminoAddresses(reserve, market);assert.notEqual(newReserve.receiptMint, newReserve.liquiditySupply);
});
test("tenancy binary decoder mirrors the 483-byte Anchor account ABI", async () => {
  const t = await tenancyFixture(), data = new Uint8Array(483), view = new DataView(data.buffer); let offset = 8;
  data.set([251, 53, 106, 214, 69, 170, 131, 234]);
  data.set(t.leaseId, offset);offset += 32;
  for (const key of [t.tenant,t.landlord,t.arbitrator,t.depositMint,t.reserve,t.market,t.receiptMint,t.liquiditySupply,t.marketAuthority,t.tenantDestination,t.landlordDestination]) { data.set(getAddressEncoder().encode(key as Parameters<ReturnType<typeof getAddressEncoder>["encode"]>[0]), offset);offset += 32; }
  data.set(t.policyHash, offset);offset += 32;data[offset++] = 1;
  for (const amount of [t.requiredSecurityAtomic,t.accountedIdleAtomic,t.accountedReceiptsAtomic,t.releasedEarningsAtomic,t.nextNonce,t.claimAtomic,t.approvedClaimAtomic]) { view.setBigUint64(offset, BigInt(amount), true);offset += 8; }
  data[offset++] = 1;data[offset] = t.bump;
  assert.deepEqual(decodeTenancy({ address: t.address, owner: program, executable: false, data }, manifest), t);
  const selected = { ...manifest, ledgerDepositMint: SOLANA_TEST_USDC_MINT };
  assert.equal(decodeTenancy({ address: t.address, owner: program, executable: false, data }, selected).depositMint, manifest.depositMint);
  data.set(getAddressEncoder().encode(address(SOLANA_TEST_USDC_MINT)), 136);
  assert.equal(decodeTenancy({ address: t.address, owner: program, executable: false, data }, manifest).depositMint, SOLANA_TEST_USDC_MINT);
  data.set(getAddressEncoder().encode(address(pair.inputMint)), 136);
  assert.throws(() => decodeTenancy({ address: t.address, owner: program, executable: false, data }, selected), /configured deployment/);
});
test("pull deployment decodes owed balances and builds one exact payout instruction", async () => {
  const t = await tenancyFixture();
  const pull = { ...manifest, escrowVersion: "pull-v2" as const };
  const data = new Uint8Array(499);
  const view = new DataView(data.buffer);
  let offset = 8;
  data.set([251, 53, 106, 214, 69, 170, 131, 234]);
  data.set(t.leaseId, offset); offset += 32;
  for (const value of [t.tenant,t.landlord,t.arbitrator,t.depositMint,t.reserve,t.market,t.receiptMint,t.liquiditySupply,t.marketAuthority,t.tenantDestination,t.landlordDestination]) {
    data.set(getAddressEncoder().encode(address(value)), offset); offset += 32;
  }
  data.set(t.policyHash, offset); offset += 32; data[offset++] = 1;
  for (const amount of [t.requiredSecurityAtomic, t.accountedIdleAtomic, t.accountedReceiptsAtomic, t.releasedEarningsAtomic, t.nextNonce, t.claimAtomic, t.approvedClaimAtomic]) {
    view.setBigUint64(offset, BigInt(amount), true); offset += 8;
  }
  data[offset++] = 5; data[offset++] = t.bump;
  view.setBigUint64(offset, 2_890_000_000n, true); offset += 8;
  view.setBigUint64(offset, 120_000_000n, true);
  const observed = decodeTenancy({ address: t.address, owner: program, executable: false, data }, pull);
  assert.equal(observed.tenantOwedAtomic, "2890000000");
  assert.equal(observed.landlordOwedAtomic, "120000000");
  assert.throws(() => decodeTenancy({ address: t.address, owner: program, executable: false, data }, manifest));
  const payout = await buildEscrowInstruction({ manifest: pull, tenancy: observed, actor: sponsor, nonce: observed.nextNonce, action: { kind: "payout", landlord: true } });
  assert.equal(payout.accounts![4].address, t.landlordDestination);
  assert.deepEqual([...payout.data!.slice(0, 9)], [149, 140, 194, 236, 174, 189, 6, 239, 1]);
  await assert.rejects(buildEscrowInstruction({ manifest, tenancy: t, actor: sponsor, nonce: t.nextNonce, action: { kind: "payout", landlord: true } }));
});
test("Jupiter permits keyless price checks while builds and test issuer routes stay gated", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++;return new Response(JSON.stringify(response)); }) as typeof fetch;
  assert.equal((await quoteInvestment(request, fetcher)).available, true);
  assert.equal((await quoteInvestment({ ...request, build: true, taker: tenant, payer: sponsor }, fetcher)).available, false);
  assert.equal((await quoteInvestment({ ...request, apiKey: "fixture", genesisHash: manifest.genesisHash }, fetcher)).available, false);
  assert.equal(calls, 1);
  const quote = await quoteInvestment({ ...request, apiKey: "fixture" }, fetcher);
  assert.equal(quote.available, true);assert.equal(calls, 2);
  if (quote.available) assert.equal(quote.value.transaction, null);
});
test("economic authorization rejects price-only, expiry, fee and recipient changes", () => {
  const quote = parseJupiterQuote({ ...response, transaction: "fixture-bytes" }, { ...request, build: true, taker: tenant, payer: sponsor });
  const authorization = { direction: "buy" as const, inputAtomic: "10000000", minimumOutputAtomic: "1200000", tenant, sponsor, nowMs: 100_000, currentBlockHeight: "90", eligibleUntilMs: 200_000, eligibility: "eligible" as const, maxFeeBps: 20 };
  assert.equal(validateQuoteForAuthorization(quote, authorization).requiresTransactionInspection, true);
  for (const changed of [{ ...quote, transaction: null }, { ...quote, transaction: "" }, { ...quote, payer: tenant }, { ...quote, receiver: landlord }, { ...quote, feeBps: 21 }, { ...quote, lastValidBlockHeight: "89" }, { ...quote, observedAtMs: 80_000 }]) assert.throws(() => validateQuoteForAuthorization(changed as JupiterQuote, authorization));
  assert.throws(() => validateQuoteForAuthorization(quote, { ...authorization, eligibility: "unknown" }));
});
test("decoded Metis limits reject appended bytes, excessive debit and redirected recipients", () => {
  const data = new Uint8Array(36), view = new DataView(data.buffer);data.set([229,23,203,151,122,227,173,42]);
  view.setUint32(8,1,true);data.set([17,1,100,0,1],12);view.setBigUint64(17,10000000n,true);view.setBigUint64(25,1280000n,true);view.setUint16(33,50,true);data[35]=0;
  const keys = [SOLANA_IDS.token,tenant,inputAccount,outputAccount,outputAccount,pair.outputMint];
  const bounds = { tenant,inputAccount,outputAccount,...pair,maximumInputAtomic:"10000000",minimumOutputAtomic:"1200000" };
  assert.equal(inspectMetisRoute(data, keys, bounds).maximumDebitAtomic, "10000000");
  assert.throws(() => inspectMetisRoute(new Uint8Array([...data, 0]), keys, bounds));
  assert.throws(() => inspectMetisRoute(data, keys, { ...bounds, maximumInputAtomic: "9999999" }));
  assert.throws(() => inspectMetisRoute(data, keys, { ...bounds, outputAccount: landlord }));
});
test("reconciliation requires finality, exact message, raw balances and actual tenant recipient", () => {
  const signature = getBase58Decoder().decode(new Uint8Array(64).fill(1));
  const row = (accountIndex:number,mint:string,amount:string,owner:string=tenant) => ({ accountIndex,mint,owner,uiTokenAmount:{amount,decimals:6} });
  const input = { signature, expectedGenesisHash:manifest.genesisHash,observedGenesisHash:manifest.genesisHash,expectedMessageSha256:"a".repeat(64),signatureStatus:{confirmationStatus:"finalized" as const,err:null},transaction:{signatures:[signature],messageSha256:"a".repeat(64),accountKeys:[inputAccount,outputAccount],slot:"100",meta:{err:null,preTokenBalances:[row(0,pair.inputMint,"10000000"),row(1,pair.outputMint,"0")],postTokenBalances:[row(0,pair.inputMint,"0"),row(1,pair.outputMint,"1280000")]}},expectedDeltas:[{account:inputAccount,mint:pair.inputMint,owner:tenant,direction:"debit" as const,minimumAtomic:"10000000",maximumAtomic:"10000000"},{account:outputAccount,mint:pair.outputMint,owner:tenant,direction:"credit" as const,minimumAtomic:"1200000",maximumAtomic:"2000000"}]};
  assert.equal(reconcileSolanaSignature(input).status,"finalized");
  assert.equal(reconcileSolanaSignature({...input,signatureStatus:null}).status,"unknown");
  assert.equal(reconcileSolanaSignature({...input,signatureStatus:{confirmationStatus:"confirmed",err:null}}).status,"pending");
  assert.equal(reconcileSolanaSignature({...input,transaction:{...input.transaction,meta:{err:null}}}).status,"unknown");
  assert.equal(reconcileSolanaSignature({...input,transaction:{...input.transaction,meta:{...input.transaction.meta,postTokenBalances:[row(0,pair.inputMint,"0"),row(1,pair.outputMint,"1280000",landlord)]}}}).status,"failed");
  assert.equal(reconcileSolanaSignature({...input,transaction:{...input.transaction,messageSha256:"b".repeat(64)}}).status,"failed");
});

test("wallet review checks exact bytes, encoded limits and every writable simulation account", async () => {
  const metis = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  const data = new Uint8Array(36), view = new DataView(data.buffer); data.set([229,23,203,151,122,227,173,42]);
  view.setUint32(8,1,true);data.set([17,1,100,0,1],12);view.setBigUint64(17,10000000n,true);view.setBigUint64(25,1280000n,true);view.setUint16(33,50,true);
  const accounts = [SOLANA_IDS.token,tenant,inputAccount,outputAccount,outputAccount,pair.outputMint,key(26),key(27),metis].map((key,index) => ({ address: address(key), role: index === 1 ? AccountRole.READONLY_SIGNER : [2,3,4].includes(index) ? AccountRole.WRITABLE : AccountRole.READONLY }));
  const message = appendTransactionMessageInstruction({ programAddress:metis,accounts,data }, setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash(key(25)),lastValidBlockHeight:99n},setTransactionMessageFeePayer(sponsor,createTransactionMessage({version:0}))));
  const bytes = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
  const token = (mint:string,amount:bigint) => {
    const data = new Uint8Array(165);data.set(getAddressEncoder().encode(address(mint)));data.set(getAddressEncoder().encode(tenant),32);data[108]=1;new DataView(data.buffer).setBigUint64(64,amount,true);
    return {owner:mint===pair.inputMint?SOLANA_IDS.token:SOLANA_IDS.token2022,lamports:"2039280",data,executable:false};
  };
  const before = { [sponsor]:{owner:SOLANA_IDS.system,lamports:"1000000000",data:new Uint8Array(),executable:false},[inputAccount]:token(pair.inputMint,10000000n),[outputAccount]:token(pair.outputMint,0n) };
  const after = { [sponsor]:{...before[sponsor],lamports:"999995000"},[inputAccount]:token(pair.inputMint,0n),[outputAccount]:token(pair.outputMint,1280000n) };
  const input = {bytes,tenant,sponsor,inputAccount,outputAccount,...pair,maximumInputAtomic:"10000000",minimumOutputAtomic:"1200000",maximumSponsorLamports:"10000",nowMs:100000,lookupTables:{},simulation:{genesisHash:SOLANA_MAINNET_MANIFEST.genesisHash,messageSha256:await messageDigest(bytes),observedAtMs:100000,err:null,before,after}};
  assert.equal((await inspectInvestmentTransaction(input)).outputAtomic,"1280000");
  await assert.rejects(inspectInvestmentTransaction({...input,maximumSponsorLamports:"4999"}));
  await assert.rejects(inspectInvestmentTransaction({...input,simulation:{...input.simulation,messageSha256:"b".repeat(64)}}));
  await assert.rejects(inspectInvestmentTransaction({...input,simulation:{...input.simulation,after:{[sponsor]:after[sponsor]}}}));
});

test("RPC transport failures remain unknown and cannot create a duplicate intent", async () => {
  const input = {rpcUrl:"https://rpc.example",signature:getBase58Decoder().decode(new Uint8Array(64).fill(1)),genesisHash:manifest.genesisHash,expectedMessageSha256:"a".repeat(64),expectedDeltas:[]};
  const result = await observeSolanaSignature(input, (async () => { throw new Error("offline"); }) as typeof fetch);
  assert.equal(result.status,"unknown");
});
