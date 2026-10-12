import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {hash} from '../src/common.ts';
import {assertAuthenticatedPublicationProvenance,authenticatePublicationProvenance,privatePublicationProvenanceSchema} from '../src/district-publication-provenance.ts';
import {writeManagedSourceArtifact} from '../src/district-private-io.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';

test('publication provenance authenticates exact bytes and live managed source bindings',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'publication-provenance-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const context=await createCivicPolicyTestContext(t),path=join(context.managedRoot,'inputs','candidate.json'),bytes=Buffer.from('{"records":[]}'),binding={kind:'prepared_source' as const,url:'https://example.org/synthetic-candidate',sourceSha256:hash('synthetic original'),observationId:'synthetic-candidate',receiptSha256:hash('synthetic receipt'),independentAllowed:true};
 await writeManagedSourceArtifact(context.managedRoot,path,bytes,[binding],{...context.policy,decisionId:context.decisionId,kind:'artifacts'});
 const inventory={schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:[{path:relative(directory,path),sha256:hash(bytes),bytes:bytes.length,bindings:[binding]}]},provenancePath=join(directory,'provenance.json'),encoded=JSON.stringify(inventory);
 await writeFile(provenancePath,encoded);
 assert.equal(privatePublicationProvenanceSchema.safeParse(inventory).success,true);
 assert.equal(privatePublicationProvenanceSchema.safeParse({...inventory,inputs:[{...inventory.inputs[0],bytes:undefined}]}).success,false);
 assert.equal(privatePublicationProvenanceSchema.safeParse({...inventory,inputs:[{...inventory.inputs[0],bindings:[{...binding,independentAllowed:undefined}]}]}).success,false);
 const provenance=await authenticatePublicationProvenance(provenancePath,hash(encoded),context.policy);
 assert.doesNotThrow(()=>assertAuthenticatedPublicationProvenance(provenance));
 assert.throws(()=>assertAuthenticatedPublicationProvenance({sha256:hash(encoded),bindings:[binding],pins:new Map(),read:async()=>bytes}),/authenticated provenance capability/);
 assert.deepEqual(await provenance.read(path),bytes);
 await writeFile(path,'tampered');
 await assert.rejects(provenance.read(path),/binding mismatch|managed source/i);
});
