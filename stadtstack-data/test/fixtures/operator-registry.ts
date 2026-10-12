import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {sha256} from '../../src/district-schema.ts';
import {operatorRegistryConfigSchema,operatorRegistryConfigContractSha256} from '../../src/district-registry-config.ts';
import {retainedPublicationSources} from '../../src/district-retained-import.ts';
export async function registryDescriptor(fixture:{root:string;decisionId:string},value:unknown,label='registry-code'){
 const codeRoot=join(fixture.root,label);await mkdir(codeRoot,{mode:0o700});
 const bytes=Buffer.from(JSON.stringify(value)+'\n'),path=join(codeRoot,'registry.json');await writeFile(path,bytes,{mode:0o600});
 const oid=(kind:string,body:Buffer)=>createHash('sha1').update(kind+' '+body.length+'\0').update(body).digest('hex');
 const treeEntry=(name:string,object:string,mode='40000')=>Buffer.concat([Buffer.from(mode+' '+name+'\0'),Buffer.from(object,'hex')]);
 const store=async(kind:string,body:Buffer)=>{const object=oid(kind,body),path=join(codeRoot,kind+'-'+object+'.bin');await writeFile(path,body,{mode:0o600});return {path,oid:object,sha256:sha256(body),bytes:body.length};};
 const blobOid=oid('blob',bytes),leaf=await store('tree',treeEntry('district-registry.json',blobOid,'100644')),middle=await store('tree',treeEntry('sources',leaf.oid)),tree=await store('tree',treeEntry('stadtstack-data',middle.oid));
 const commit=await store('commit',Buffer.from(`tree ${tree.oid}\nauthor Synthetic Fixture <fixture@example.test> 0 +0000\ncommitter Synthetic Fixture <fixture@example.test> 0 +0000\n\nSynthetic registry configuration\n`));
 const registry=operatorRegistryConfigSchema.parse({kind:'operator_registry_config',path,sha256:sha256(bytes),bytes:bytes.length,schemaContractSha256:await operatorRegistryConfigContractSha256(),code:{gitCommit:commit.oid,path:'stadtstack-data/sources/district-registry.json',blobOid,sha256:sha256(bytes),bytes:bytes.length},commit,trees:[leaf,middle,tree],approval:{role:'district_source_registry',approver:'owner',decisionId:fixture.decisionId,date:'2026-10-11',configurationSha256:sha256(bytes),gitCommit:commit.oid},declaredEndpoints:[...new Set(retainedPublicationSources(value).map(source=>source.url))]});
 return registry;
}
