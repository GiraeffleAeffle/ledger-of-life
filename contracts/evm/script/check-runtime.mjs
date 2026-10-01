import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, keccak256, parseAbi, toHex } from 'viem';
import {
  assertRentalEscrowRuntime,
  rentalEscrowRuntime,
} from '../../../src/finance/robinhood/deployment.ts';

const path = fileURLToPath(new URL('../out/RentalEscrow.sol/RentalEscrow.json', import.meta.url));
const artifact = JSON.parse(readFileSync(path, 'utf8'));
const code = artifact.deployedBytecode.object;
const references = Object.values(artifact.deployedBytecode.immutableReferences)
  .flat()
  .sort((a, b) => a.start - b.start);
assert.deepEqual(
  references.map((reference) => reference.start),
  [...rentalEscrowRuntime.immutableOffsets],
);
assert.ok(references.every((reference) => reference.length === 32));
assertRentalEscrowRuntime(code, keccak256(code));
const first = rentalEscrowRuntime.immutableOffsets[0] * 2 + 2;
const configured = code.slice(0, first) + '1'.repeat(64) + code.slice(first + 64);
assertRentalEscrowRuntime(configured, keccak256(configured));
assert.throws(() => assertRentalEscrowRuntime(configured, keccak256(code)));
const modified = `0x00${configured.slice(4)}`;
assert.throws(() => assertRentalEscrowRuntime(modified, keccak256(modified)));
console.log(
  'Compiled runtime, immutable normalization, exact deployment binding and mutation rejection passed.',
);

// These are build pins, not a claim that the share factory has been deployed.
const shareManifest = JSON.parse(readFileSync(
  fileURLToPath(new URL('../deployments/share-deposit-46630.json', import.meta.url)), 'utf8',
));
assert.equal(shareManifest.chainId, 46630);
assert.equal(shareManifest.stock, '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E');
assert.equal(shareManifest.oracle, '0x5196C8713A529bd676B875fB9Cea3F8a47ba48Be');
const sharedManifest = JSON.parse(readFileSync(
  fileURLToPath(new URL('../deployments/shared-market-46630.json', import.meta.url)), 'utf8',
));
assert.deepEqual(shareManifest.collateralIssuer, sharedManifest.collateralIssuer);
for (const field of ['stock', 'oracle']) {
  assert.equal(shareManifest.dependencyCodeHashes[field], sharedManifest.codeHashes[field]);
}
assert.deepEqual(shareManifest.tokenIdentity, {
  decimals: 18, multiplier: '1000000000000000000', permitName: 'Tesla',
  permitVersion: '1', permitChainId: 46630, paused: false,
});
const configuredShareRuntimes = new Map();
function bindShareRuntime(compiled, pins, name) {
  let configured = compiled.deployedBytecode.object;
  const groups = Object.values(compiled.deployedBytecode.immutableReferences);
  const anchors = Object.entries(pins.immutableAnchors);
  assert.equal(anchors.length, groups.length, `${name} complete immutable bindings`);
  const expected = name === 'ShareDeposit'
    ? ['factory', 'stock', 'oracle', 'chainId'] : ['implementation'];
  assert.deepEqual(anchors.map(([, field]) => field).sort(), expected.sort());
  for (const [anchor, field] of anchors) {
    const refs = groups.filter(group => group.some(ref => ref.start === Number(anchor)));
    assert.equal(refs.length, 1, `${name} reviewed immutable anchor ${anchor}`);
    const value = toHex(BigInt(shareManifest[field]), { size: 32 }).slice(2);
    for (const ref of refs[0]) {
      assert.equal(ref.length, 32);
      const start = ref.start * 2 + 2;
      assert.equal(configured.slice(start, start + 64), '0'.repeat(64), `${name} template immutable slot`);
      configured = configured.slice(0, start) + value + configured.slice(start + 64);
    }
  }
  return configured;
}
for (const name of ['ShareDeposit', 'ShareDepositFactory']) {
  const compiled = JSON.parse(readFileSync(fileURLToPath(
    new URL(`../out/${name}.sol/${name}.json`, import.meta.url),
  ), 'utf8'));
  const pins = shareManifest.reviewedArtifacts[name];
  assert.equal(keccak256(compiled.bytecode.object), pins.creationHash, `${name} creation pin`);
  assert.equal(keccak256(compiled.deployedBytecode.object), pins.runtimeTemplateHash, `${name} runtime pin`);
  assert.ok((compiled.deployedBytecode.object.length - 2) / 2 <= 24_576, `${name} EIP-170 limit`);
  if (shareManifest.status === 'deployed') {
    const configured = bindShareRuntime(compiled, pins, name);
    const hashField = name === 'ShareDeposit' ? 'implementationCodeHash' : 'factoryCodeHash';
    assert.equal(keccak256(configured), shareManifest[hashField], `${name} exact deployed immutable binding`);
    configuredShareRuntimes.set(name, configured);
  }
}
if (shareManifest.status === 'not_deployed') {
  for (const key of ['factory', 'implementation', 'factoryCodeHash', 'implementationCodeHash',
    'deploymentTransaction', 'deploymentBlock']) assert.equal(shareManifest[key], null);
} else {
  assert.equal(shareManifest.status, 'deployed');
  for (const key of ['factory', 'implementation']) assert.match(shareManifest[key], /^0x[0-9a-fA-F]{40}$/);
  for (const key of ['factoryCodeHash', 'implementationCodeHash', 'deploymentTransaction']) {
    assert.match(shareManifest[key], /^0x[0-9a-fA-F]{64}$/);
  }
  assert.ok(Number.isSafeInteger(shareManifest.deploymentBlock) && shareManifest.deploymentBlock > 0);
  assert.equal(shareManifest.deploymentStatus, 1);
  assert.match(shareManifest.deployer, /^0x[0-9a-fA-F]{40}$/);
  assert.match(shareManifest.deploymentGasUsed, /^[1-9][0-9]*$/);
}
console.log('Share-deposit reviewed creation/runtime pins and manifest shape passed.');

// CI remains offline. Explicit --live verifies receipt, code and readbacks using public reads only.
if (process.argv.includes('--live')) {
  assert.equal(shareManifest.status, 'deployed');
  const client = createPublicClient({ transport: http('https://rpc.testnet.chain.robinhood.com') });
  assert.equal(await client.getChainId(), shareManifest.chainId);
  const receipt = await client.getTransactionReceipt({ hash: shareManifest.deploymentTransaction });
  assert.equal(receipt.status, 'success');
  assert.equal(receipt.blockNumber, BigInt(shareManifest.deploymentBlock));
  assert.equal(receipt.gasUsed, BigInt(shareManifest.deploymentGasUsed));
  assert.equal(receipt.from.toLowerCase(), shareManifest.deployer.toLowerCase());
  assert.equal(receipt.contractAddress.toLowerCase(), shareManifest.factory.toLowerCase());
  for (const [name, configured] of configuredShareRuntimes) {
    const address = name === 'ShareDeposit' ? shareManifest.implementation : shareManifest.factory;
    const deployed = await client.getCode({ address });
    assert.equal(deployed?.toLowerCase(), configured.toLowerCase(), `${name} live exact runtime`);
  }
  const factoryAbi = parseAbi(['function implementation() view returns (address)']);
  assert.equal((await client.readContract({
    address: shareManifest.factory, abi: factoryAbi, functionName: 'implementation',
  })).toLowerCase(), shareManifest.implementation.toLowerCase());
  const implementationAbi = parseAbi([
    'function stock() view returns (address)', 'function oracle() view returns (address)',
    'function factory() view returns (address)', 'function fixedChainId() view returns (uint256)',
    'function state() view returns (uint8)',
  ]);
  for (const field of ['stock', 'oracle', 'factory']) {
    assert.equal((await client.readContract({
      address: shareManifest.implementation, abi: implementationAbi, functionName: field,
    })).toLowerCase(), shareManifest[field].toLowerCase());
  }
  assert.equal(await client.readContract({
    address: shareManifest.implementation, abi: implementationAbi, functionName: 'fixedChainId',
  }), BigInt(shareManifest.chainId));
  assert.equal(await client.readContract({
    address: shareManifest.implementation, abi: implementationAbi, functionName: 'state',
  }), 4);
  console.log('Share-deposit live receipt, exact configured runtimes and locked implementation readbacks passed.');
}
