import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CIVIC_ACQUISITION_DECISION_ID,provisionCivicPolicyAuthority} from '../../src/civic-opt-out.ts';
import type {CivicPolicyOptions} from '../../src/civic-opt-out.ts';

/** Real isolated authority provisioning; never changes HOME or authorizes a missing state store. */
export async function createCivicPolicyTestContext(test?:{after:(callback:()=>Promise<void>)=>void}) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'civic-policy-test-'))),stateDir=join(root,'policy');
 const authority=await provisionCivicPolicyAuthority({stateDir,authorityId:'fixture:'+randomUUID()});
 const policy:CivicPolicyOptions={stateDir,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 const dispose=()=>rm(root,{recursive:true,force:true});
 test?.after(dispose);
 return {root,policy,managedRoot:join(root,'source-content'),decisionId:CIVIC_ACQUISITION_DECISION_ID,dispose};
}
