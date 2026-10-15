import {z} from 'zod';
import {readReleaseFile} from './data-release.ts';
import type {DataRelease} from './data-release.ts';
import {ObservationSchema} from './district-adapter-contract.ts';
import {structuredFieldPublicationHold} from './district-public-fields.ts';
import type {ReleaseExceptionItem} from './r1-release-acceptance.ts';

export const RELEASE_ACCEPTANCE_RULES={version:'r1-option-b-candidate-scope-v1',rules:[
  {class:'technical/replay/value',condition:'Any required gate fails or its pinned binding is invalid',decision:'block'},
  {class:'unknown',condition:'Unknown/ambiguous classification, incomplete inventory or unprovable exclusion',decision:'block'},
  {class:'withheld_in_candidate',condition:'Quarantined/withheld material or derived identifiers are in the candidate',decision:'block'},
  {class:'rights/legal',condition:'Affected material is in the candidate, or a source-level question affects a source contributing candidate material',decision:'block'},
  {class:'origin/disagreement/critical',condition:'Affected document, claim, record or derived material is in the candidate without resolution',decision:'block'},
  {class:'excluded_risk',condition:'Affected material is authenticated as excluded; for source-level rights/legal the source contributes no candidate material',decision:'known_gap; ownerAuditPriority=high'},
  {class:'quality/context/infrastructure/access',condition:'Controlled non-admission; affected material remains excluded',decision:'known_gap'},
  {class:'negative',condition:'Genuine no_supported_case',decision:'negative; no value credit'},
  {class:'superseded_assessment',condition:'Every affected record has a selected full A/B/C admission and current admitted membership; not a rights/legal waiver',decision:'informational'},
  {class:'owner_sample',condition:'All release gates pass; only the reproducibly drawn sample audit is outstanding',decision:'may follow release under option B; never mark owner-reviewed'},
]} as const;
export interface CandidateMaterialContext {
  manifestSha256:string;ids:string[];sourceHashes:string[];sourceUrls:string[];sourceScopes:string[];materialBlockers:string[];
}
/** Read only manifest-bound material, not diagnostic coverage/quarantine counts. */
export async function readCandidateMaterialContext(directory:string,manifest:DataRelease,manifestSha256:string):Promise<CandidateMaterialContext>{
  const ids=new Set<string>(),hashes=new Set<string>(),urls=new Set<string>(),scopes=new Set<string>(),blockers=new Set<string>();
  const attributedUrls:{url:string;municipalityId:string}[]=[];
  const visit=(value:unknown,municipalityId:string,parentKey=''):void=>{
    if(Array.isArray(value)){value.forEach(child=>visit(child,municipalityId,parentKey));return;}
    if(!value||typeof value!=='object')return;
    const node=z.record(z.string(),z.unknown()).parse(value);
    const municipality=typeof node.municipalityId==='string'?node.municipalityId:typeof node.cityId==='string'?node.cityId:municipalityId;
    if(typeof node.sourceId==='string'&&municipality)scopes.add(municipality+'\n'+node.sourceId);
    if(typeof node.url==='string'){
      urls.add(node.url);attributedUrls.push({url:node.url,municipalityId:municipality});
      const sourceId=typeof node.registrySourceId==='string'?node.registrySourceId:node.id;
      if(typeof sourceId==='string'&&municipality&&['source','sources','supportingSources'].includes(parentKey))scopes.add(municipality+'\n'+sourceId);
    }
    for(const [key,child] of Object.entries(node)){
      if(['id','recordId','claimId','entityId','subjectId','objectId','from','to','sourceRecordId','derivedFromRecordId'].includes(key)&&typeof child==='string')ids.add(child);
      if(['recordIds','memberRecordIds','sourceRecordIds','claimIds'].includes(key)&&Array.isArray(child))for(const id of child)if(typeof id==='string')ids.add(id);
      if(['sha256','sourceSha256','inputSha256'].includes(key)&&typeof child==='string'&&/^[a-f0-9]{64}$/.test(child))hashes.add(child);
    }
    for(const key of ['status','reviewState','publicationStatus'])if(typeof node[key]==='string'&&/^(?:quarantined|withheld|held(?:_.*)?|rejected_quality|blocked_policy)$/.test(node[key]))blockers.add('withheld_material_in_candidate');
    if(node.published===false||node.withheld===true||node.quarantined===true)blockers.add('withheld_material_in_candidate');
    if(node.kind==='structured'){
      const observation=ObservationSchema.safeParse(node.observation);
      if(!observation.success||structuredFieldPublicationHold(observation.data))blockers.add('withheld_native_field_in_candidate');
    }
    for(const [key,child] of Object.entries(node))if(!['coverage','quality','accounting','limitations','quarantineReasons','withheldContext'].includes(key))visit(child,municipality,key);
  };
  for(const member of manifest.files)if(member.path==='knowledge/records.json'||member.path==='knowledge/graph.json'
    ||member.path==='core/strausberg-facts.json'||member.path.startsWith('regions/')||member.path.startsWith('cities/')&&/(?:signals(?:\.min)?\.geojson|feed\.json)$/.test(member.path)){
    const city=member.path.startsWith('cities/')?member.path.split('/')[1]:member.path==='core/strausberg-facts.json'?'strausberg':'';
    const content=JSON.parse((await readReleaseFile(directory,manifest,member.path)).toString('utf8'));
    visit(member.path.endsWith('/feed.json')?z.object({items:z.array(z.unknown())}).passthrough().parse(content).items:content,city);
  }
  // Registry URLs identify source scope; registry presence alone never counts as
  // contribution. Only an actually attributed material URL can activate it.
  const registry=z.record(z.string(),z.unknown()).parse(JSON.parse((await readReleaseFile(directory,manifest,'knowledge/registry.json')).toString('utf8')));
  const municipalitySchema=z.object({id:z.string(),sources:z.array(z.object({id:z.string(),url:z.string().nullable()}).passthrough())}).passthrough();
  for(const city of z.array(municipalitySchema).parse(registry.municipalities))for(const source of city.sources){
    if(!source.url)continue;
    const root=new URL(source.url);
    if(attributedUrls.some(attribution=>{
      if(attribution.municipalityId&&attribution.municipalityId!==city.id)return false;
      const url=new URL(attribution.url);
      return url.origin===root.origin&&(url.pathname===root.pathname||url.pathname.startsWith(root.pathname.endsWith('/')?root.pathname:root.pathname+'/'));
    }))scopes.add(city.id+'\n'+source.id);
  }
  return {manifestSha256,ids:[...ids].sort(),sourceHashes:[...hashes].sort(),sourceUrls:[...urls].sort(),sourceScopes:[...scopes].sort(),materialBlockers:[...blockers].sort()};
}
interface SourceDisposition {municipalityId:string;sourceId:string;sourceSha256:string;admittedRecordIds:string[]}
export function bindReleaseExceptionContext(items:ReleaseExceptionItem[],context:CandidateMaterialContext,sourceDispositions:SourceDisposition[]):ReleaseExceptionItem[]{
  const ids=new Set(context.ids),hashes=new Set(context.sourceHashes),scopes=new Set(context.sourceScopes);
  return items.map<ReleaseExceptionItem>(item=>{
    if(['negative','superseded_assessment','execution_history','withheld_in_candidate'].includes(item.classification)||item.classification==='unknown')return item;
    const match=/^sourceDispositions\/(\d+)\//.exec(item.origin);
    const raw=z.record(z.string(),z.unknown()).safeParse(item.evidence);
    const source=match?sourceDispositions[Number(match[1])]:sourceDispositions.find(source=>item.recordIds.some(id=>source.admittedRecordIds.includes(id)));
    const municipalityId=source?.municipalityId??(raw.success&&typeof raw.data.municipalityId==='string'?raw.data.municipalityId:null);
    const sourceId=source?.sourceId??(raw.success&&typeof raw.data.sourceId==='string'?raw.data.sourceId:null);
    const sourceSha256=source?.sourceSha256??(raw.success&&typeof raw.data.sourceSha256==='string'?raw.data.sourceSha256:null);
    const sourceContributes=municipalityId&&sourceId?scopes.has(municipalityId+'\n'+sourceId)||sourceDispositions.some(other=>other.municipalityId===municipalityId&&other.sourceId===sourceId&&hashes.has(other.sourceSha256)):null;
    const candidateAffected=item.recordIds.length?item.recordIds.some(id=>ids.has(id)):sourceSha256?hashes.has(sourceSha256):sourceContributes===false?false:null;
    const reasons:string[]=[];
    const visit=(node:unknown):void=>{if(Array.isArray(node)){node.forEach(visit);return;}if(node&&typeof node==='object')for(const [key,child] of Object.entries(node)){
      if(['reason','reasonCode','holdReasons'].includes(key)){if(typeof child==='string')reasons.push(child);else if(Array.isArray(child))for(const reason of child)if(typeof reason==='string')reasons.push(reason);}
      else visit(child);
    }};visit(item.evidence);
    const sourceLevel=/tdm|robots|opt.?out|source[_ -](?:rights|legal|copyright|permission|privacy|policy)|(?:rights|legal|copyright|permission|privacy)[_ -](?:of[_ -](?:the[_ -])?)?source|policy_(?:excluded|expired)|(?:^|\s)rights(?:_|\s|$)|(?:^|\s)permission(?:_|\s|$)/i.test(reasons.join(' '));
    const scoped={...item,candidateAffected,sourceContributes,sourceLevel};
    if(item.classification==='known_gap'||item.classification==='privacy_excluded'){
      return candidateAffected===true?{...scoped,classification:'withheld_in_candidate',blocking:true,ownerAuditPriority:'high'}:scoped;
    }
    const rightsOrLegal=item.classification==='rights'||item.classification==='legal';
    if(candidateAffected===true||rightsOrLegal&&sourceLevel&&sourceContributes===true)return {...scoped,blocking:true,ownerAuditPriority:'high'};
    if(candidateAffected===null||rightsOrLegal&&sourceLevel&&sourceContributes===null)return {...scoped,classification:'unknown',blocking:true,ownerAuditPriority:'high'};
    return {...scoped,classification:'known_gap',blocking:false,ownerAuditPriority:'high'};
  });
}
