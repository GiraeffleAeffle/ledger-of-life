import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {Catalogue,Signal} from './schema.ts';
import {isPublicUrl,publicUrlReason} from './publication-quality.ts';
import {assertTopic,assignTopics,topicMatches,topicRegistry,topicRegistryVersion,type TopicTag} from './topics.ts';
import {geoFeeds} from './geodata-registry.ts';
import type {DistrictKnowledgeRecord} from './district-schema.ts';
import {compareDistrictTopic,matchesFilters,similarDistrictRecords,type DistrictFilters} from './district-query.ts';
import {districtCoverageSchema} from './district-publication.ts';

export interface RegistrySourceSummary {id:string;kind:string;url:string|null;checkState:'checked'|'not_found'|'not_checked'}
export interface KnowledgeMunicipality {id:string;name:string;ags:string;districtId:string;sources:RegistrySourceSummary[];administrativeStatus?:'amtsfrei'|'amtsangehoerig';amt?:{id:string;name:string;sourceUrl:string}|null}
export type KnowledgeQueryData={records:DistrictKnowledgeRecord[];municipalities:KnowledgeMunicipality[];coverage:unknown};
const municipalityRecordCoverageSchema=districtCoverageSchema.shape.municipalities.element.pick({id:true,status:true,documents:true,publishedRecords:true,datedStagedRecords:true,quarantinedRecords:true}).strip();
export type MunicipalityRecordCoverage=z.infer<typeof municipalityRecordCoverageSchema>;

export const regionalSchema=z.object({schemaVersion:z.literal('stadtstack-regional-topics-v1'),generatedAt:z.string(),asOf:z.string(),region:z.object({id:z.string(),name:z.string()}).passthrough(),municipalities:z.array(z.object({id:z.string(),name:z.string(),ags:z.string().optional()}).passthrough()),topics:z.array(z.object({id:z.string(),label:z.string(),municipalities:z.array(z.object({municipalityId:z.string(),stage:z.string(),items:z.array(z.object({title:z.string(),url:z.url(),date:z.string().nullable(),sourceType:z.string(),locator:z.string(),stage:z.string()}).passthrough())}))}))});
export type Regional=z.infer<typeof regionalSchema>;
export const queryFields=['id','cityId','recordType','title','statement','topics','eventDate','endDate','dateSemantics','status','stage','asOf','sourceIds','sourceTypes','comparisonEligible','comparisonReason','geometry','category','nextStep','unknowns','verification','assertion','reviewState','geometryPrecision','origin','districtId','ags','caseKey','caseKeyType','documentDate','stageDate','originalStatus','stageQuote','entities','locations','extraction','stages','documentDateReason','stageDateReason','documentDateQuote','stageDateQuote','titleQuote','summaryQuote','municipalityQuote','caseQuote'] as const;
export const defaultFields=['id','cityId','recordType','title','topics','eventDate','documentDate','stageDate','dateSemantics','status','asOf','sourceIds','comparisonEligible'] as const;
export const cityIdSchema=z.string().regex(/^[a-z0-9-]{1,80}$/);
export const queryShape={query:z.string().trim().min(1).max(200).optional(),topic:z.string().trim().min(1).max(80).optional(),recordTypes:z.array(z.enum(['planning','construction','infrastructure','roadworks','council_paper','council_meeting','budget','consultation','place','measurement','regional_item','unknown'])).min(1).max(12).optional(),sourceTypes:z.array(z.string().min(1).max(80)).min(1).max(20).optional(),stage:z.string().min(1).max(80).optional(),dateFrom:z.iso.date().optional(),dateTo:z.iso.date().optional(),excludePlaces:z.boolean().default(false),excludeOSM:z.boolean().default(false),cursor:z.string().min(1).max(2048).optional(),limit:z.number().int().min(1).max(50).default(20),fields:z.array(z.enum(queryFields)).min(1).max(queryFields.length).optional()};
export const querySchema=z.object({...queryShape,cityIds:z.array(cityIdSchema).min(1).max(50).optional()}).strict();
export type QueryOptions=z.infer<typeof querySchema>;
export type QueryRecord={id:string;cityId:string;recordType:string;title:string;statement:string;topics:TopicTag[];eventDate:string|null;endDate:string|null;dateSemantics:'source_event'|'source_document'|'observation'|'unknown';status:string;stage:string|null;asOf:string;sourceIds:string[];sourceTypes:string[];comparisonEligible:boolean;comparisonReason:string|null;geometry:Signal['geometry'];origin:'city'|'regional'|'knowledge';category:string;nextStep?:string;unknowns?:string[];verification?:Signal['properties']['verification']|DistrictKnowledgeRecord['verification'];assertion?:Signal['properties']['assertion'];reviewState?:string;geometryPrecision?:string;districtId?:string;ags?:string;caseKey?:string;caseKeyType?:string;documentDate?:string|null;stageDate?:string|null;originalStatus?:string;stageQuote?:string;entities?:DistrictKnowledgeRecord['entities'];locations?:DistrictKnowledgeRecord['locations'];extraction?:DistrictKnowledgeRecord['extraction']} & Partial<Pick<DistrictKnowledgeRecord,'stages'|'documentDateReason'|'stageDateReason'|'documentDateQuote'|'stageDateQuote'|'titleQuote'|'summaryQuote'|'municipalityQuote'|'caseQuote'>>;
const cursorKey=randomBytes(32); // Process-only signing key, never an owner token; restart expires cursors.
function canonical(value:unknown):string {
  if(Array.isArray(value))return JSON.stringify(value.map(item=>JSON.parse(canonical(item))));
  if(value&&typeof value==='object')return JSON.stringify(Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,JSON.parse(canonical(v))])));
  return JSON.stringify(value);
}
export function publicData(value:unknown,field=''):unknown {
  if(Array.isArray(value))return value.map(item=>publicData(item,field));
  const relativeExport=(field==='feedUrl'||field==='minUrl')&&typeof value==='string'&&/^cities\/[a-z0-9-]+\/(?:feed\.json|signals\.min\.geojson)$/.test(value);
  if(typeof value==='string'&&!relativeExport&&(/(?:url|uri)$/i.test(field)||/^[a-z][a-z0-9+.-]*:\/\//i.test(value)))return isPublicUrl(value)?value:null;
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,publicData(item,key)]));
  return value;
}
function signalSourceTypes(feature:Signal):string[]{
 const p=feature.properties;
 if(p.id.startsWith('osm:'))return ['osm'];
 if(p.id.startsWith('atlas:'))return ['atlas'];
 if(p.id.startsWith('autobahn:'))return ['autobahn'];
 const geo=geoFeeds.find(feed=>p.id.startsWith(feed.id+':'));
 if(geo)return [geo.sourceType];
 if(p.kind==='council_paper'||p.kind==='council_meeting'){
  const kinds=new Set<string>();
  for(const source of p.sources){
   if((source.snapshotUrl??source.url).includes('github.com/komma-systems/ccf/'))kinds.add('ccf');
   else if(/\/oparl\/|\/bodies\/|\/body\//i.test(source.snapshotUrl??source.url))kinds.add('oparl');
   else if(/\.pdf(?:[?#]|$)/i.test(source.url))kinds.add('pdf');
  }
  return kinds.size?[...kinds].sort():['unknown'];
 }
 return p.sources.some(source=>/\.pdf(?:[?#]|$)/i.test(source.url))?['pdf']:['unknown'];
}
export class QueryIndex {
  readonly records:QueryRecord[]=[];
  readonly sources=new Map<string,Record<string,unknown>>();
  readonly municipalities=new Map<string,{id:string;name:string;coverage:'city_catalogue'|'regional_evidence_only'|'district_evidence_only';ags?:string;districtId?:string;sources?:RegistrySourceSummary[];administrativeStatus?:KnowledgeMunicipality['administrativeStatus'];amt?:KnowledgeMunicipality['amt'];recordCoverage?:MunicipalityRecordCoverage|null}>();
  readonly releaseId:string;
  readonly releasedAt:string;
  readonly regional:Regional;
  readonly knowledge?:KnowledgeQueryData;
  private readonly sourceTypeSet=new Set<string>();
  private readonly stageSet=new Set<string>();
  constructor(releaseId:string,releasedAt:string,features:Signal[],regional:Regional,catalogue:Catalogue,knowledge?:KnowledgeQueryData) {
    this.releaseId=releaseId;this.releasedAt=releasedAt;this.regional=regional;this.knowledge=knowledge;
    for(const city of catalogue.cities)this.municipalities.set(city.id,{id:city.id,name:city.name,coverage:'city_catalogue'});
    for(const municipality of regional.municipalities) {
      const previous=this.municipalities.get(municipality.id);
      this.municipalities.set(municipality.id,{id:municipality.id,name:previous?.name??municipality.name,coverage:previous?.coverage??'regional_evidence_only',ags:municipality.ags});
    }
    for(const feature of features) {
      const p=feature.properties;
      const sourceIds=p.sources.map(source=>this.addSource(source));
      const observation=p.kind==='place';
      const eventDate=p.startDate;
      this.records.push({id:p.id,cityId:p.cityId,recordType:p.kind,title:p.title,statement:p.statement,topics:assignTopics(`${p.title}\n${p.statement}`,sourceIds),eventDate,endDate:p.endDate,dateSemantics:observation?'observation':eventDate?'source_event':'unknown',status:p.status,stage:null,asOf:p.asOf,sourceIds,sourceTypes:signalSourceTypes(feature),comparisonEligible:observation||eventDate!==null,comparisonReason:!observation&&eventDate===null?'Required source/event date unknown; withheld from comparison':null,geometry:feature.geometry,origin:'city',category:p.category,nextStep:p.nextStep,unknowns:p.unknowns,verification:p.verification,assertion:p.assertion,reviewState:p.reviewState,geometryPrecision:p.geometryPrecision});
    }
    const regionalRecords=new Map<string,QueryRecord>();
    for(const topic of regional.topics)for(const municipality of topic.municipalities)for(const item of municipality.items) {
      if(!this.municipalities.has(municipality.municipalityId))throw Error('Unknown regional municipality in released evidence');
      // URL + exact source locator identify an evidence item, not a title or inferred case.
      const identity=canonical({municipalityId:municipality.municipalityId,url:item.url,locator:item.locator});
      const id=`regional:${createHash('sha256').update(identity).digest('hex')}`;
      const sourceId=this.addSource({url:item.url,title:item.title,publisher:'Official regional evidence (see source URL)',locator:item.locator,retrievedAt:null,asOf:regional.asOf,retrievalNote:'Regional snapshot asOf is known; an individual source retrieval timestamp is not supplied.',licence:'unknown',reuse:'facts_with_attribution',sourceType:item.sourceType,licenceNote:'No open licence inferred by the query layer; see released regional source evidence.'});
      const sourceIds=[sourceId];
      const tags=assignTopics(item.title,sourceIds);
      if(topicRegistry.some(entry=>entry.id===topic.id)&&!tags.some(tag=>tag.id===topic.id))tags.push({id:topic.id,assignment:'source',ruleId:'released-regional-topic-v1',evidence:item.locator,sourceIds});
      const existing=regionalRecords.get(id);
      if(existing) {
        if(existing.title!==item.title||existing.eventDate!==item.date||existing.status!==item.stage)throw Error('Conflicting regional source identity');
        for(const tag of tags)if(!existing.topics.some(t=>t.id===tag.id))existing.topics.push(tag);
        continue;
      }
      const record:QueryRecord={id,cityId:municipality.municipalityId,recordType:item.sourceType==='planningProcedure'?'planning':item.sourceType==='councilAgenda'?'council_paper':'regional_item',title:item.title,statement:item.locator,topics:tags,eventDate:item.date,endDate:null,dateSemantics:item.date?'source_event':'unknown',status:item.stage,stage:item.stage,asOf:regional.asOf,sourceIds,sourceTypes:[item.sourceType],comparisonEligible:item.date!==null&&item.stage!=='unknown',comparisonReason:item.date===null?'Required source/event date unknown; withheld from comparison':item.stage==='unknown'?'Source stage unknown; withheld from comparison':null,geometry:null,origin:'regional',category:topic.label,geometryPrecision:'none'};
      regionalRecords.set(id,record);
    }
    this.records.push(...regionalRecords.values());
    const admissionRows=knowledge?z.object({municipalities:z.array(municipalityRecordCoverageSchema)}).parse(knowledge.coverage).municipalities:[];
    const admissionByCity=new Map(admissionRows.map(row=>[row.id,row]));
    for(const municipality of knowledge?.municipalities??[]) {
      const previous=this.municipalities.get(municipality.id);
      this.municipalities.set(municipality.id,{id:municipality.id,name:municipality.name,ags:municipality.ags,districtId:municipality.districtId,administrativeStatus:municipality.administrativeStatus,amt:municipality.amt,sources:municipality.sources.map(({id,kind,url,checkState})=>({id,kind,url,checkState})),recordCoverage:admissionByCity.get(municipality.id)??null,coverage:previous?.coverage==='city_catalogue'?'city_catalogue':'district_evidence_only'});
    }
    for(const record of knowledge?.records??[]) {
      if(!this.municipalities.has(record.municipalityId))throw Error('Unknown normalized knowledge municipality');
      if(this.records.some(existing=>existing.id===record.id))throw Error('Duplicate released record identity');
      const sourceIds=record.sources.map(source=>this.addSource({...source,registrySourceId:source.id,publisher:record.municipalityId}));
      const verification=record.verification;
      const verified=verification.status==='auto-verified'&&verification.deterministic.passed&&verification.faithfulness.score!==null&&verification.faithfulness.score>=verification.faithfulness.threshold;
      const hasSourcedDate=record.documentDate!==null||record.stageDate!==null||record.stages.some(event=>event.date!==null);
      const comparisonReason=!verified?'Verification gates not passed; candidate evidence only':!hasSourcedDate?'Required sourced document/stage date unknown':record.stage==='unknown'||!record.stageQuote.trim()?'Source stage unknown or unsupported':null;
      const sourceTypes=[...new Set(record.sources.map(source=>source.sourceType))];
      // Infrastructure is a case type, not proof construction started; unknown stays unknown.
      const recordType=record.caseType;
      const observedAt=record.sources.map(source=>source.retrievedAt).sort().at(-1)!;
      this.records.push({id:record.id,cityId:record.municipalityId,ags:record.ags,districtId:record.districtId,recordType,title:record.title,statement:record.summary,topics:record.topics.map(topic=>({...topic,assignment:topic.provenance,ruleId:topic.provenance==='rule'?`${topicRegistryVersion}:${topic.id}`:record.extraction.promptVersion,evidence:topic.quote,sourceIds})),eventDate:record.stageDate,endDate:null,dateSemantics:record.stageDate?'source_event':record.documentDate?'source_document':'unknown',documentDate:record.documentDate,stageDate:record.stageDate,status:record.originalStatus,originalStatus:record.originalStatus,stage:record.stage,stageQuote:record.stageQuote,caseKey:record.caseKey,caseKeyType:record.caseKeyType,asOf:observedAt,sourceIds,sourceTypes,comparisonEligible:comparisonReason===null,comparisonReason,geometry:null,origin:'knowledge',category:record.topics.map(topic=>topic.id).join(', '),verification,entities:record.entities,locations:record.locations,extraction:record.extraction,geometryPrecision:'none',stages:record.stages,documentDateReason:record.documentDateReason,stageDateReason:record.stageDateReason,documentDateQuote:record.documentDateQuote,stageDateQuote:record.stageDateQuote,titleQuote:record.titleQuote,summaryQuote:record.summaryQuote,municipalityQuote:record.municipalityQuote,caseQuote:record.caseQuote});
    }
    for(const record of this.records){
      for(const type of record.sourceTypes)this.sourceTypeSet.add(type);
      if(record.stage)this.stageSet.add(record.stage);
    }
    this.records.sort((a,b)=>this.recordKey(a).localeCompare(this.recordKey(b),'en'));
  }
  private recordKey(record:QueryRecord){return `${record.cityId}:${record.id}`;}
  private addSource(source:Record<string,unknown>) {
    const id=`source:${createHash('sha256').update(canonical({url:source.url,locator:source.locator,publisher:source.publisher,sha256:source.sha256??null})).digest('hex')}`;
    const safe=publicData(source) as Record<string,unknown>;
    if(typeof source.url==='string'&&!isPublicUrl(source.url)){safe.url=null;safe.urlWithheldReason=publicUrlReason(source.url);}
    this.sources.set(id,{...safe,id});
    return id;
  }
  assertCities(ids?:string[]) {
    for(const id of ids??[])if(!this.municipalities.has(id))throw Error(`Unknown city or regional municipality: ${id}. Use list_cities/list_topics.`);
  }
  listTopics(cityIds?:string[]) {
    this.assertCities(cityIds);
    const cities=[...this.municipalities.values()].filter(city=>!cityIds||cityIds.includes(city.id));
    const counts:Record<string,{count:number;withheldCount:number}>={};
    for(const record of this.records) {
      if(cityIds&&!cityIds.includes(record.cityId))continue;
      for(const topic of topicRegistry.filter(topic=>record.topics.some(tag=>topicMatches(tag.id,topic.id)))) {
        const key=`${topic.id}:${record.cityId}`;
        const count=counts[key]??={count:0,withheldCount:0};
        if(record.comparisonEligible)count.count++;else count.withheldCount++;
      }
    }
    return {registryVersion:topicRegistryVersion,scope:'Shared hierarchical topics; rules and extracted topics retain provenance, source quotes and model confidence where supplied. Counts describe evidence, not municipal performance.',cities,topics:topicRegistry.map(topic=>{
      const perCity=cities.map(city=>({cityId:city.id,...(counts[`${topic.id}:${city.id}`]??{count:0,withheldCount:0})}));
      return {id:topic.id,parentId:topic.parentId,label:topic.label,summary:topic.summary,ruleId:topic.ruleId,total:perCity.reduce((total,city)=>total+city.count,0),perCity};
    })};
  }
  private validateFilters(options:DistrictFilters) {
    assertTopic(options.topic);this.assertCities(options.cityIds);
    if(options.dateFrom&&options.dateTo&&options.dateFrom>options.dateTo)throw Error('dateFrom must not be later than dateTo');
    for(const type of options.sourceTypes??[])if(!this.sourceTypeSet.has(type))throw Error(`Unknown source type: ${type}`);
    if(options.stage&&!this.stageSet.has(options.stage))throw Error(`Unknown released stage: ${options.stage}`);
  }
  compareTopic(topic:string,cityIds:string[],filters:DistrictFilters={}) {
    const options={...filters,topic,cityIds};this.validateFilters(options);
    const coverage=this.knowledge?.coverage;
    const rows=coverage&&typeof coverage==='object'&&'municipalities' in coverage&&Array.isArray(coverage.municipalities)?coverage.municipalities: [];
    return {releaseId:this.releaseId,...compareDistrictTopic(this.records,[...new Set(cityIds)],options,cityId=>{
      const municipality=this.municipalities.get(cityId);
      return {municipality:municipality?{id:municipality.id,name:municipality.name,ags:municipality.ags,districtId:municipality.districtId,coverage:municipality.coverage}:null,
        sourceCoverage:rows.find(row=>row&&typeof row==='object'&&row.id===cityId)??null,
        scope:'This municipality only; missing records do not establish absence of activity.'};
    },this.releasedAt)};
  }
  similar(id:string,filters:DistrictFilters={},limit=20) {
    this.validateFilters(filters);
    if(!Number.isInteger(limit)||limit<1||limit>50)throw Error('limit must be between 1 and 50');
    return {releaseId:this.releaseId,...similarDistrictRecords(this.records,id,filters,limit)};
  }
  page(options:Partial<QueryOptions>,scope:string,eligible=this.records,extra:unknown=null,includeWithheld=false) {
    this.validateFilters(options);
    if(options.fields?.some(field=>!queryFields.includes(field)))throw Error('Unknown projection field');
    const limit=options.limit??20;
    if(!Number.isInteger(limit)||limit<1||limit>50)throw Error('limit must be between 1 and 50');
    const fields=[...new Set(options.fields??defaultFields)].sort();
    const {cursor,...filters}=options;
    const binding=createHash('sha256').update(canonical({scope,filters:{...filters,fields,cityIds:options.cityIds?[...new Set(options.cityIds)].sort():undefined,recordTypes:options.recordTypes?[...new Set(options.recordTypes)].sort():undefined,sourceTypes:options.sourceTypes?[...new Set(options.sourceTypes)].sort():undefined,limit,excludePlaces:options.excludePlaces??false},extra,includeWithheld})).digest('hex');
    let after:string|undefined;
    if(cursor) {
      const parts=cursor.split('.');
      if(parts.length!==2||!parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)))throw Error('Invalid cursor');
      const signature=createHmac('sha256',cursorKey).update(parts[0]).digest();
      const supplied=Buffer.from(parts[1],'base64url');
      if(supplied.toString('base64url')!==parts[1]||signature.length!==supplied.length||!timingSafeEqual(signature,supplied))throw Error('Invalid or expired cursor');
      let decoded:unknown;try{decoded=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));}catch{throw Error('Invalid cursor');}
      const payload=z.object({v:z.literal(1),release:z.string(),binding:z.string(),after:z.string()}).strict().safeParse(decoded);
      if(!payload.success)throw Error('Invalid cursor');
      if(payload.data.release!==this.releaseId||payload.data.binding!==binding)throw Error('Cursor release or filters mismatch');
      after=payload.data.after;
    }
    const matches=eligible.filter(record=>(includeWithheld||record.comparisonEligible)&&matchesFilters(record,options));
    let start=0;
    if(after!==undefined){const index=matches.findIndex(record=>this.recordKey(record)===after);if(index<0)throw Error('Cursor record not found in released query');start=index+1;}
    const records=matches.slice(start,start+limit);
    let nextCursor:string|null=null;
    if(start+limit<matches.length) {
      const payload=Buffer.from(JSON.stringify({v:1,release:this.releaseId,binding,after:this.recordKey(records[records.length-1])})).toString('base64url');
      nextCursor=`${payload}.${createHmac('sha256',cursorKey).update(payload).digest('base64url')}`;
    }
    return {items:records.map(record=>Object.fromEntries(fields.map(field=>[field,record[field]]))),total:matches.length,nextCursor,withheld:{count:eligible.filter(record=>!record.comparisonEligible&&matchesFilters(record,options)).length,meaning:includeWithheld?'Discovery includes explicitly ineligible evidence; never compare these items as dated progress':'Missing required dates/status or failed verification gates withheld from comparison; get_regional_topics includes regional and normalized discovery evidence'},fields};
  }
}
