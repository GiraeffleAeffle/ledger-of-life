import type {StructuredObservation} from './district-adapter-contract.ts';

/** Same public-contact boundary for text claims and native field publication. */
export const PUBLIC_CONTACT_PATTERN=/[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:tel(?:efon)?|fax|mobil)\s*[:.]?\s*\+?\d[\d\s/()-]{5,}/iu;
export type StructuredFieldHold='narrative_requires_text_model'|'source_literal_exceeds_short_quote'|'contact_field';
const publicMetadataFields=['publisherId','sourceId','nativeId','nativeVersion','kind','subject','predicate','unit','date','dateRole','sourceReferenceDate','publishedAt'] as const;
const contact=(value:unknown)=>typeof value==='string'&&PUBLIC_CONTACT_PATTERN.test(value);
const longLiteral=(value:unknown)=>typeof value==='string'&&value.length>1800;
function locatorContact(locator:StructuredObservation['evidence'][number]):boolean{
 return contact(locator.rawValue)||contact(locator.nativeId)||contact(locator.path)||contact(locator.sheet)||contact(locator.rowKey)||locator.cells.some(contact);
}
/** Keep original native output private; never repair/truncate a source field into admissible evidence. */
export function structuredFieldPublicationHold(observation:StructuredObservation):StructuredFieldHold|null{
 if(/(?:^|_)(?:resolution_text|description|purpose|summary|statement|narrative)(?:_|$)/i.test(observation.predicate))return 'narrative_requires_text_model';
 if(longLiteral(observation.value)||observation.evidence.some(item=>longLiteral(item.rawValue))||observation.supportingEvidence.some(item=>longLiteral(item.locator.rawValue))||observation.limitations.some(longLiteral))return 'source_literal_exceeds_short_quote';
 if(/(?:^|_)(?:contact|phone|email|person_name|fax|telefon)(?:_|$)/i.test(observation.predicate)||contact(observation.value)||publicMetadataFields.some(key=>contact(observation[key]))||observation.limitations.some(contact)||observation.evidence.some(locatorContact)||observation.supportingEvidence.some(item=>locatorContact(item.locator)))return 'contact_field';
 return null;
}
