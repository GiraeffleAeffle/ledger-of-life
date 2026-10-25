import test from 'node:test';
import assert from 'node:assert/strict';
import {step8PublicationProvenanceBounds,assertStep8ProvenanceSizes} from '../src/r1-step8-publication-bounds.ts';
import {provenanceBytes,PROVENANCE_LIMIT_BYTES,PROVENANCE_SAFETY_MARGIN_BYTES} from '../src/publication-provenance-partition.ts';

const binding={kind:'http_observation' as const,url:'https://example.invalid/synthetic-bound',sourceSha256:'a'.repeat(64),observationId:'synthetic-bound',receiptSha256:'b'.repeat(64),independentAllowed:false};
const fixed={path:'/synthetic/native/records.json',sha256:'c'.repeat(64),bytes:1,bindings:[binding]},stage={...fixed,path:'/synthetic/retained/catalogue.json'};

test('publication pre-pass sizes the exact retained inventory and bounds every generated row without issuing pins',()=>{
 const input={fixedInputs:[fixed,stage],stagingPaths:[stage.path],outputRoot:'/synthetic/candidate',textBindings:[binding],nativeBindings:[binding],registryBindings:[binding]},result=step8PublicationProvenanceBounds(input);
 assert.equal(result.pass,true);assert.equal(result.stagingExactBytes,provenanceBytes([stage]).length);assert.equal(result.generatedInputs.length,9);
 assert.deepEqual(result.generatedInputs.map(row=>row.path.split('/').at(-1)).sort(),['critical.json','identity.json','policy.json','publication-inputs.json','quarantine.json','records.json','registry.json','structured-run.json','text-composition.json']);
 const actualRows=result.generatedInputs.map(row=>({path:row.path,sha256:'d'.repeat(64),bytes:1,bindings:[binding]}));
 assert.ok(provenanceBytes([fixed,...actualRows]).length<=result.primaryUpperBoundBytes);
 assert.equal(JSON.stringify(result).includes('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),false,'diagnostic contains bounds, never invented artifact pins');
 assert.deepEqual(step8PublicationProvenanceBounds(input),result);
});

test('both inventories refuse at the unchanged16MiB limit minus at least1MiB, including equality',()=>{
 const maximum=PROVENANCE_LIMIT_BYTES-PROVENANCE_SAFETY_MARGIN_BYTES;
 assert.equal(PROVENANCE_SAFETY_MARGIN_BYTES,1024*1024);
 assert.doesNotThrow(()=>assertStep8ProvenanceSizes('publication',maximum-1,maximum-1));
 assert.throws(()=>assertStep8ProvenanceSizes('publication',maximum,1),/primary provenance/);
 assert.throws(()=>assertStep8ProvenanceSizes('publication',1,maximum),/staging provenance/);
 assert.throws(()=>assertStep8ProvenanceSizes('publication',Number.NaN,1));
});
