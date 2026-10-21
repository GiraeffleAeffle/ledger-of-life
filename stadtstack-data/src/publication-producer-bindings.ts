import {semanticHash} from './district-adapter-contract.ts';
import type {SourceArtifactBinding} from './district-private-io.ts';
import {normalizePublicationBindings} from './publication-binding-normalization.ts';

/** Producer declarations only. Every caller must still authenticate the inputs
 * and use the unchanged Core source-write/complete-binding boundaries. */
export function derivedProducerBindings(bindings:readonly SourceArtifactBinding[]):SourceArtifactBinding[]{
 return normalizePublicationBindings(bindings.map(binding=>({...binding,independentAllowed:false})));
}
export function producerBindingSetSha256(bindings:readonly SourceArtifactBinding[]){return semanticHash(derivedProducerBindings(bindings));}
export interface PublicationProducerGroups {
 knowledge:readonly SourceArtifactBinding[];
 staging:ReadonlyMap<string,readonly SourceArtifactBinding[]>;
 whole:readonly SourceArtifactBinding[];
 regional:readonly SourceArtifactBinding[];
}
export function publicationMemberProducerBindings(member:string,groups:PublicationProducerGroups):SourceArtifactBinding[]{
 const staged=(destinations:string[])=>derivedProducerBindings(destinations.flatMap(destination=>{const bindings=groups.staging.get(destination);if(!bindings?.length)throw Error('Missing release member producer: '+destination);return [...bindings];}));
 if(member.startsWith('knowledge/'))return derivedProducerBindings(groups.knowledge);
 const city=/^cities\/([^/]+)\/(signals(?:\.min)?\.geojson|feed\.json|changes\.json)$/.exec(member);
 if(city)return staged([`cities/${city[1]}/signals.geojson`,...(city[2]==='feed.json'?[`cities/${city[1]}/feed.json`]:[])]);
 if(member.startsWith('core/'))return staged(['core/strausberg-facts.json','cities/strausberg/signals.geojson']);
 if(member==='regions/brandenburg-mol/topics.json')return derivedProducerBindings([...staged([member]),...groups.regional]);
 if(member==='catalogue.json')return staged(['catalogue.json',...[...groups.staging.keys()].filter(path=>/^cities\/[^/]+\/signals\.geojson$/.test(path)).sort()]);
 if(['quality-report.json','release-manifest.json','README.md'].includes(member))return derivedProducerBindings(groups.whole);
 throw Error('Unknown release member producer: '+member);
}
