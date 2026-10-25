import {assertHostNotOptedOut,readCivicOptOutSnapshot} from './civic-opt-out.ts';
import type {CivicPolicyOptions} from './civic-opt-out.ts';

/** Explicit VM-candidate boundary only. Sealed hosted packages do not load it. */
export async function assertVmReleaseSources(urls:readonly string[],policy:CivicPolicyOptions={}):Promise<void>{
 const epoch=await readCivicOptOutSnapshot(policy),pinned={...policy,authorityId:epoch.authorityId,authoritySha256:epoch.authoritySha256};
 for(const url of urls)await assertHostNotOptedOut(url,pinned);
 if((await readCivicOptOutSnapshot(pinned)).sha256!==epoch.sha256)throw Error('Current policy changed during VM candidate serving');
}
