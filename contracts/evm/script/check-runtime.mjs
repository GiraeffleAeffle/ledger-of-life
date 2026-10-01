import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { concat, createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, toHex } from 'viem';
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

// Build pins remain distinct from deployment evidence for the building distributor.
const buildingManifest = JSON.parse(readFileSync(fileURLToPath(
  new URL('../deployments/building-revenue-46630.json', import.meta.url),
), 'utf8'));
const investmentsManifest = JSON.parse(readFileSync(fileURLToPath(
  new URL('../deployments/local-investments-46630.json', import.meta.url),
), 'utf8'));
assert.equal(buildingManifest.version, 3);
assert.equal(buildingManifest.rewardsSpec.scheme, 'staking_stream_v1');
assert.equal(buildingManifest.rewardsSpec.scale, '1000000000000000000000000000000000000');
assert.equal(buildingManifest.rewardDuration, 604_800);
assert.ok(!Object.hasOwn(buildingManifest, 'operator') && !Object.hasOwn(buildingManifest, 'merkleSpec'), 'no obsolete epoch/operator manifest');
assert.equal(buildingManifest.chainId, 46630);
assert.equal(buildingManifest.payoutToken, investmentsManifest.cashAddress);
assert.equal(buildingManifest.unitToken, investmentsManifest.assets['demo-neighbourhood-homes'].unitAddress);
assert.deepEqual(buildingManifest.dependencyCodeHashes, {
  payoutToken: investmentsManifest.cashCodeHash,
  unitToken: investmentsManifest.assets['demo-neighbourhood-homes'].unitCodeHash,
});
const buildingCompiled = JSON.parse(readFileSync(fileURLToPath(
  new URL('../out/BuildingRevenueDistributor.sol/BuildingRevenueDistributor.json', import.meta.url),
), 'utf8'));
const buildingPins = buildingManifest.reviewedArtifacts.BuildingRevenueDistributor;
assert.equal(keccak256(buildingCompiled.bytecode.object), buildingPins.creationHash, 'building creation pin');
assert.equal(keccak256(buildingCompiled.deployedBytecode.object), buildingPins.runtimeTemplateHash, 'building runtime pin');
assert.ok((buildingCompiled.deployedBytecode.object.length - 2) / 2 <= 24_576, 'building EIP-170 limit');
const buildingGroups = Object.values(buildingCompiled.deployedBytecode.immutableReferences);
const buildingAnchors = Object.entries(buildingPins.immutableAnchors);
assert.equal(buildingAnchors.length, buildingGroups.length, 'building complete immutable bindings');
assert.deepEqual(buildingAnchors.map(([, field]) => field).sort(), ['payoutToken', 'rewardDuration', 'unitToken']);
let buildingConfiguredRuntime = buildingCompiled.deployedBytecode.object;
const boundBuildingGroups = new Set();
for (const [anchor, field] of buildingAnchors) {
  const matching = buildingGroups.filter(group => group.some(ref => ref.start === Number(anchor)));
  assert.equal(matching.length, 1, `building reviewed immutable anchor ${anchor}`);
  assert.ok(!boundBuildingGroups.has(matching[0]), 'building unique immutable group');
  boundBuildingGroups.add(matching[0]);
  const value = toHex(BigInt(buildingManifest[field]), { size: 32 }).slice(2);
  for (const ref of matching[0]) {
    assert.equal(ref.length, 32);
    const start = ref.start * 2 + 2;
    assert.equal(buildingConfiguredRuntime.slice(start, start + 64), '0'.repeat(64), 'building template slot');
    buildingConfiguredRuntime = buildingConfiguredRuntime.slice(0, start) + value + buildingConfiguredRuntime.slice(start + 64);
  }
}
if (buildingManifest.status === 'not_deployed') {
  for (const key of ['distributor', 'runtimeCodeHash', 'deploymentTransaction', 'deploymentBlock']) {
    assert.equal(buildingManifest[key], null, `building unavailable ${key}`);
  }
} else {
  assert.equal(buildingManifest.status, 'deployed');
  assert.match(buildingManifest.distributor, /^0x[0-9a-fA-F]{40}$/);
  assert.match(buildingManifest.deploymentTransaction, /^0x[0-9a-fA-F]{64}$/);
  assert.equal(buildingManifest.deploymentStatus, 1);
  assert.match(buildingManifest.deploymentGasUsed, /^[1-9][0-9]*$/);
  assert.match(buildingManifest.deployer, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(buildingManifest.verification.status, 'verified');
  assert.equal(buildingManifest.verification.provider, 'blockscout');
  assert.equal(buildingManifest.verification.compilerVersion, 'v0.8.28+commit.7893614a');
  assert.equal(buildingManifest.verification.optimizerRuns, 200);
  assert.equal(buildingManifest.verification.evmVersion, 'cancun');
  assert.ok(Number.isSafeInteger(buildingManifest.deploymentBlock) && buildingManifest.deploymentBlock > 0);
  assert.equal(keccak256(buildingConfiguredRuntime), buildingManifest.runtimeCodeHash, 'building exact deployed immutable binding');
}
console.log('Building distributor reviewed creation/runtime pins, dependencies and manifest shape passed.');

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
  if (buildingManifest.status === 'deployed') {
    const buildingReceipt = await client.getTransactionReceipt({ hash: buildingManifest.deploymentTransaction });
    assert.equal(buildingReceipt.status, 'success');
    assert.equal(buildingReceipt.blockNumber, BigInt(buildingManifest.deploymentBlock));
    assert.equal(buildingReceipt.contractAddress.toLowerCase(), buildingManifest.distributor.toLowerCase());
    assert.equal(buildingReceipt.gasUsed, BigInt(buildingManifest.deploymentGasUsed));
    assert.equal(buildingReceipt.from.toLowerCase(), buildingManifest.deployer.toLowerCase());
    const buildingTransaction = await client.getTransaction({ hash: buildingManifest.deploymentTransaction });
    assert.equal(buildingTransaction.to, null, 'building direct creation transaction');
    const buildingConstructor = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [buildingManifest.payoutToken, buildingManifest.unitToken, BigInt(buildingManifest.rewardDuration)],
    );
    assert.equal(buildingTransaction.input.toLowerCase(), concat([
      buildingCompiled.bytecode.object, buildingConstructor,
    ]).toLowerCase(), 'building exact creation and constructor arguments');
    const deployed = await client.getCode({ address: buildingManifest.distributor });
    assert.equal(deployed?.toLowerCase(), buildingConfiguredRuntime.toLowerCase(), 'building live exact runtime');
    let buildingNormalizedRuntime = deployed;
    for (const group of buildingGroups) {
      for (const ref of group) {
        const start = ref.start * 2 + 2;
        buildingNormalizedRuntime = buildingNormalizedRuntime.slice(0, start)
          + '0'.repeat(ref.length * 2) + buildingNormalizedRuntime.slice(start + ref.length * 2);
      }
    }
    assert.equal(keccak256(buildingNormalizedRuntime), buildingPins.runtimeTemplateHash, 'building live normalized reviewed template');
    assert.equal(keccak256(deployed), buildingManifest.runtimeCodeHash, 'building live configured code hash');
    const buildingAbi = parseAbi([
      'function payoutToken() view returns (address)', 'function unitToken() view returns (address)',
      'function rewardDuration() view returns (uint256)', 'function rewardScale() view returns (uint256)',
    ]);
    for (const field of ['payoutToken', 'unitToken']) {
      assert.equal((await client.readContract({
        address: buildingManifest.distributor, abi: buildingAbi, functionName: field,
      })).toLowerCase(), buildingManifest[field].toLowerCase());
    }
    assert.equal(await client.readContract({
      address: buildingManifest.distributor, abi: buildingAbi, functionName: 'rewardDuration',
    }), BigInt(buildingManifest.rewardDuration));
    assert.equal(await client.readContract({
      address: buildingManifest.distributor, abi: buildingAbi, functionName: 'rewardScale',
    }), BigInt(buildingManifest.rewardsSpec.scale));
    for (const field of ['payoutToken', 'unitToken']) {
      const dependency = await client.getCode({ address: buildingManifest[field] });
      assert.equal(keccak256(dependency), buildingManifest.dependencyCodeHashes[field], `building live ${field} code`);
    }
    const explorerResponse = await fetch(`https://explorer.testnet.chain.robinhood.com/api/v2/smart-contracts/${buildingManifest.distributor}`);
    assert.ok(explorerResponse.ok, 'building explorer verification response');
    const explorer = await explorerResponse.json();
    assert.equal(explorer.is_verified, true, 'building verified source');
    assert.equal(explorer.is_fully_verified, true, 'building fully verified source');
    assert.equal(explorer.compiler_version, buildingManifest.verification.compilerVersion);
    assert.equal(explorer.optimization_runs, buildingManifest.verification.optimizerRuns);
    assert.equal(explorer.evm_version, buildingManifest.verification.evmVersion);
    assert.equal(explorer.source_code, readFileSync(fileURLToPath(
      new URL('../src/BuildingRevenueDistributor.sol', import.meta.url),
    ), 'utf8'), 'building exact explorer source');
    console.log('Building distributor live receipt, creation, normalized/exact runtimes, immutable readbacks and verified source passed.');
  } else {
    console.log('Building distributor is not deployed; live verification is unavailable.');
  }
}
