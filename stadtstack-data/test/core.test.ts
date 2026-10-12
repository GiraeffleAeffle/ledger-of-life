import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ZodError} from 'zod';
import {hash,outDir} from '../src/common.ts';
import {validateCore,deterministic,selected} from '../src/core.ts';
import {collectionSchema} from '../src/schema.ts';
import {compactCollection} from '../src/min.ts';
import {searchText} from '../src/mcp.ts';
import type {CoreBundle} from '../src/core-schema.ts';
const bundle=JSON.parse(await readFile(join(outDir,'core','strausberg-facts.json'),'utf8')) as CoreBundle;
const collection=collectionSchema.parse(JSON.parse(await readFile(join(outDir,'cities','strausberg','signals.geojson'),'utf8')));
test('retained released core binds assertions and original judge evidence without new raw-source verification',async()=>{assert.equal(validateCore(bundle,collection).facts.length,3);const manifest=JSON.parse(await readFile(join(outDir,'core','release-manifest.json'),'utf8'));assert.equal(manifest.bundleSha256,hash(await readFile(join(outDir,manifest.bundlePath))));assert.equal(manifest.bundleVersion,bundle.version);assert.equal(manifest.corpus.fullSha256,hash(await readFile(join(outDir,manifest.corpus.fullPath))));assert.equal(manifest.corpus.minSha256,hash(await readFile(join(outDir,manifest.corpus.minPath))));});
test('every missing, low, changed-source or tampered core gate fails',()=>{
 assert.throws(()=>validateCore(undefined,collection));
 for(const fact of bundle.facts){
  for(const mutate of [(f:CoreBundle['facts'][number])=>{f.verification.faithfulness.score=.79;},(f:CoreBundle['facts'][number])=>{f.verification.deterministic.passed=false as true;},(f:CoreBundle['facts'][number])=>{f.source.sha256='0'.repeat(64);},(f:CoreBundle['facts'][number])=>{f.verification.faithfulness.reason+=' altered';},(f:CoreBundle['facts'][number])=>{f.assertion.value+=1;}]){const copy=structuredClone(bundle);mutate(copy.facts.find(f=>f.id===fact.id)!);assert.throws(()=>validateCore(copy,collection));}
  assert.throws(()=>validateCore({...bundle,facts:bundle.facts.filter(f=>f.id!==fact.id)},collection));
 }
 assert.throws(()=>validateCore(bundle,{...collection,features:collection.features.filter(f=>f.properties.id!==selected[0].id)}));
});
test('extractor rejects neighboring dates and swapped plan columns',()=>{
 const lake='Stand: 05.10.2026 Normalstau 65,49 m DHHN 92 14.09.2026 -26 63,88 Wert vom LfU erhalten 161';assert.ok(deterministic(lake,selected[0].id));assert.throws(()=>deterministic(lake.replace('14.09.2026','21.09.2026'),selected[0].id));
 const budget='Stand: 07.11.2024 Haushaltsjahr 2025 2026 festgesetzt Auszahlungen aus Investitionstätigkeit 17.941.270,00 EUR 12.609.320,00 EUR';assert.ok(deterministic(budget,selected[1].id));assert.throws(()=>deterministic(budget.replace('17.941.270,00 EUR 12.609.320,00 EUR','12.609.320,00 EUR 17.941.270,00 EUR'),selected[1].id));
});
test('compact corpus and text/topic MCP retain citywide core and identical evidence',()=>{
 const compact=compactCollection(collection);for(const fact of bundle.facts){const p=compact.features.find(f=>f.properties.id===fact.id)!.properties;assert.equal(p.version,fact.version);assert.deepEqual(p.verification,fact.verification);assert.deepEqual(p.assertion,fact.assertion);}
 assert.ok(searchText(collection.features,'Straussee').some(f=>f.properties.id===selected[0].id));for(const fact of bundle.facts.slice(1))assert.ok(searchText(collection.features,String(fact.assertion.year),'haushalt').some(f=>f.properties.id===fact.id));
});
test('canonical pre-publication core gate rejects low faithfulness without modifying retained evidence',async()=>{
 // Governed plan/output behavior is covered in publish.test.ts. This is the
 // canonical core gate, not the retired implicit CLI or a copied partial runtime.
 const paths=['cities/strausberg/signals.geojson','core/strausberg-facts.json','core/release-manifest.json','release-manifest.json'];
 const before=await Promise.all(paths.map(path=>readFile(join(outDir,path))));
 const bad=structuredClone(bundle);bad.facts[2].verification.faithfulness.score=.1;
 const bytes=JSON.stringify(bad),candidate=JSON.parse(bytes),corpus=structuredClone(collection);
 assert.throws(()=>validateCore(candidate,corpus),(error:unknown)=>error instanceof ZodError&&error.issues.some(issue=>issue.path.join('.')==='facts.2.verification.faithfulness.score'));
 assert.equal(JSON.stringify(candidate),bytes);
 assert.deepEqual(corpus,collection);
 assert.deepEqual(await Promise.all(paths.map(path=>readFile(join(outDir,path)))),before);
});
