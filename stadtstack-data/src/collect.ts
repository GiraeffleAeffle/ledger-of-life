import {relative,resolve} from 'node:path';
import {CIVIC_POLICY_AUTHORITY,assertCivicPolicyAuthority} from './civic-opt-out.ts';
import {readPinnedJson} from './district-private-io.ts';
import {RETAINED_PUBLICATION_ROOT,RetainedPublicationImportPlanSchema,runRetainedPublicationImportPlan} from './district-retained-import.ts';
import {HISTORICAL_GIT_SNAPSHOT_ROOT,AuthenticatedGitSnapshotImportPlanSchema,runAuthenticatedGitSnapshotImportPlan} from './district-git-snapshot-import.ts';

// Collection is now an explicit offline import, never a live adapter or stale fallback.
const [planPath,planSha256,...extra]=process.argv.slice(2);
if(!planPath||!planSha256||extra.length)throw Error('Usage: collect.ts IMPORT_PLAN_JSON IMPORT_PLAN_SHA256');
try{
 await assertCivicPolicyAuthority(CIVIC_POLICY_AUTHORITY);
 const input=await readPinnedJson(planPath,planSha256,8*1024*1024);
 if(!input||typeof input!=='object'||!('schemaVersion' in input))throw Error('Pinned import plan schema required');
 if(input.schemaVersion==='stadtstack-retained-import-plan-v1'){
  const plan=RetainedPublicationImportPlanSchema.parse(input);
  if(resolve(plan.managedRoot)!==RETAINED_PUBLICATION_ROOT)throw Error('Collection requires the managed retained-publication root');
  const receipts=await runRetainedPublicationImportPlan(plan,CIVIC_POLICY_AUTHORITY);
  console.log(JSON.stringify({schemaVersion:'stadtstack-retained-import-run-v1',planSha256,importedMembers:receipts.length,imports:receipts.map(receipt=>({publication:receipt.publication,destinationPath:relative(plan.managedRoot,receipt.path),sha256:receipt.sha256,bytes:receipt.bytes,bindingCount:receipt.bindings.length}))}));
 }else if(input.schemaVersion==='stadtstack-git-snapshot-import-plan-v1'){
  const plan=AuthenticatedGitSnapshotImportPlanSchema.parse(input);
  if(resolve(plan.managedRoot)!==HISTORICAL_GIT_SNAPSHOT_ROOT)throw Error('Collection requires the private historical-change snapshot root');
  const receipts=await runAuthenticatedGitSnapshotImportPlan(plan,CIVIC_POLICY_AUTHORITY);
  console.log(JSON.stringify({schemaVersion:'stadtstack-git-snapshot-import-run-v1',purpose:'historical_change_reconstruction_only',planSha256,importedMembers:receipts.length,imports:receipts.map(receipt=>({snapshot:receipt.snapshot,destinationPath:relative(plan.managedRoot,receipt.path),sha256:receipt.sha256,bytes:receipt.bytes,bindingCount:receipt.bindings.length}))}));
 }else throw Error('Unsupported pinned offline import plan');
}catch{
 // Do not print source bodies, declarations, paths or parser diagnostics on failure.
 console.error('Pinned offline collection import failed; check plan pins, provenance declarations and current civic policy.');
 process.exitCode=1;
}
