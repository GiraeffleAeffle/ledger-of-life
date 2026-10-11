import { createHash } from 'node:crypto';
import { z } from 'zod';

const quote = z.string().min(1).max(1800);
const localId = z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/);
export const entityTypeSchema = z.enum(['municipality', 'authority', 'organization', 'project', 'facility', 'funding_programme', 'law', 'place', 'company']);
export const relationTypeSchema = z.enum(['operates', 'funds', 'implements', 'plans', 'decides', 'approves', 'amends', 'located_in', 'cooperates_with', 'cites']);
export const relationModalitySchema = z.enum(['asserted', 'planned', 'decided', 'implemented', 'proposed', 'conditional', 'negated', 'historical']);
export const EntityMentionSchema = z.object({
  mentionId: localId, name: z.string().min(1).max(300), type: entityTypeSchema, quote,
  identifiers: z.array(z.object({ value: z.string().min(1).max(200), namespace: z.string().min(1).max(120), issuer: z.string().min(1).max(300), quote }).strict()).max(8),
}).strict();
export const RelationClaimSchema = z.object({
  fromMention: localId, toMention: localId, type: relationTypeSchema, quote, predicateQuote: quote,
  modality: relationModalitySchema,
  time: z.object({ text: quote, quote }).strict().nullable(), conditions: quote.nullable(),
}).strict();
export const IdentityBasisSchema = z.object({
  kind: z.enum(['explicit_identifier', 'municipality_scoped_name', 'source_scoped_name']),
  key: z.string().min(1), scope: z.string().min(1).nullable(),
  ambiguity: z.literal('Source-grounded identity grouping, not independent legal-entity verification.'),
}).strict();
export const NormalizedEntitySchema = EntityMentionSchema.extend({ entityId: z.string().regex(/^entity:[a-f0-9]{64}$/), identityBasis: IdentityBasisSchema }).strict();
export const NormalizedRelationSchema = RelationClaimSchema.extend({ fromId: z.string().regex(/^entity:[a-f0-9]{64}$/), toId: z.string().regex(/^entity:[a-f0-9]{64}$/) }).strict();
export type GraphClaims = { entities: z.infer<typeof EntityMentionSchema>[]; relations: z.infer<typeof RelationClaimSchema>[]; documentDate?: string | null };
export const RELATION_ACTION_NORMALIZATION_VERSION = 'relation-actions-v1';
export const RelationActionNormalizationSchema = z.object({
  version: z.literal(RELATION_ACTION_NORMALIZATION_VERSION),
  mappings: z.array(z.object({
    index: z.number().int().nonnegative(), originalType: relationTypeSchema, originalModality: relationModalitySchema,
    type: relationTypeSchema, modality: relationModalitySchema,
    rule: z.enum(['explicit-planning', 'explicit-decision', 'explicit-approval', 'explicit-implementation']),
    quoteSha256: z.string().regex(/^[a-f0-9]{64}$/), predicateQuoteSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(60),
}).strict();
export type RelationActionNormalization = z.infer<typeof RelationActionNormalizationSchema>;
export type GraphContext = { municipalityId: string; sourceSha256: string };
export const GRAPH_DETERMINISTIC_CHECKS = ['graph_mentions', 'graph_identifiers', 'graph_relations', 'graph_modality'] as const;
export const GRAPH_IDENTITY_VERSION = 'municipality-name-v2';
/**
 * First observed type in this precedence is the graph's display type, never a
 * legal classification. Mention types remain unchanged and do not key identity.
 */
export const ENTITY_TYPE_PRECEDENCE = ['municipality', 'authority', 'company', 'organization', 'funding_programme', 'project', 'facility', 'law', 'place'] as const satisfies readonly z.infer<typeof entityTypeSchema>[];
const ambiguity = 'Source-grounded identity grouping, not independent legal-entity verification.' as const;
const sourceScopedNames: Record<string, true> = { projekt: true, vorhaben: true, schulneubau: true, schule: true, kita: true, kindertagesstätte: true, solarpark: true, windpark: true, anlage: true, bebauungsplan: true, flächennutzungsplan: true, hauptsatzung: true, satzung: true, gesetz: true };
const nameForm=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('de').replace(/[„“”]/gu,'\"').replace(/[‐‑–—]/gu,'-').replace(/\s+/gu,' ').trim();
function sourceScopedName(name:string):boolean{
  const plain=nameForm(name).replace(/\b(?:der|die|das|des|den|ein|eine|und|co|gmbh|ag|kg|aör|eg|ev|ltd)\b/gu,' ').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/gu,' ');
  return !plain||Object.hasOwn(sourceScopedNames,plain)||/^(?:änderung|aenderung|projekt|vorhaben|plan)\s*\d*$/u.test(plain)||/^(?:\d+|erste|zweite|dritte|vierte|fünfte|sechste|siebte|achte|neunte|zehnte)\s+(?:änderung|aenderung)(?:\s+(?:satzung|hauptsatzung|gesetz|bebauungsplan|flächennutzungsplan))?$/u.test(plain);
}
/** Labels may collapse whitespace, while supporting quotations remain exact source spans. */
function quotedName(quote:string,name:string):boolean{return quote.replace(/\s+/gu,' ').includes(name.replace(/\s+/gu,' ').trim());}

export function normalizeGraphClaims(claims: GraphClaims, context: GraphContext) {
  const entities = claims.entities.map(entity => {
    // Exact complete identifier sets never bridge conflicting or unidentified mentions.
    // Keep the whole normalized name, including legal forms, even for identifiers.
    // Name alone is never a cross-municipality identity assertion.
    const identifiers = [...new Set(entity.identifiers.map(id => JSON.stringify([id.namespace, id.issuer, id.value])))].sort();
    // Ambiguous object/amendment labels stay source-scoped regardless of mention type.
    const sourceScoped = !identifiers.length && sourceScopedName(entity.name);
    const scope = identifiers.length ? null : sourceScoped ? `${context.municipalityId}:${context.sourceSha256}` : context.municipalityId;
    const kind = identifiers.length ? 'explicit_identifier' as const : sourceScoped ? 'source_scoped_name' as const : 'municipality_scoped_name' as const;
    const key = JSON.stringify([GRAPH_IDENTITY_VERSION, nameForm(entity.name), identifiers, scope]);
    return { ...entity, entityId: `entity:${createHash('sha256').update(key).digest('hex')}`, identityBasis: { kind, key, scope, ambiguity } };
  });
  const byMention = new Map(entities.map(entity => [entity.mentionId, entity]));
  if (byMention.size !== entities.length) throw Error('Duplicate graph mention ID');
  const relations = claims.relations.map(relation => {
    const from = byMention.get(relation.fromMention), to = byMention.get(relation.toMention);
    if (!from || !to) throw Error('Unknown graph relation endpoint');
    return { ...relation, fromId: from.entityId, toId: to.entityId };
  });
  return { entities, relations };
}

// Lexical support is only a precheck: a named builder may plan to errichten a project,
// but direction, modality and completion still require source-faithfulness judgment.
const predicates: Record<z.infer<typeof relationTypeSchema>, RegExp> = {
  operates: /\b(?:betreibt|betreiben|betrieb|betrieben|Betreiber(?:in)?|Träger(?:in)?|operates?|operated)\b/iu,
  funds: /\b(?:fördert|fördern|gefördert|finanziert|finanzieren|bezuschusst|Förderung|Zuwendung|funds?|funded|finances?)\b/iu,
  implements: /\b(?:realisiert|realisieren|errichtet|errichten|umgesetzt|umsetzen|setzt.{0,50}um|durchgeführt|durchführen|führt.{0,50}durch|implements?|implemented)\b/iu,
  plans: /(?<![\p{L}\p{N}])(?:plant|planen|geplant|beabsichtigt|beabsichtigen|plans?|planned)(?![\p{L}\p{N}])/iu,
  decides: /(?<![\p{L}\p{N}])(?:beschließt|beschließen|beschloss|beschlossen|entscheidet|entschieden|decides?|decided)(?![\p{L}\p{N}])/iu,
  approves: /(?<![\p{L}\p{N}])(?:genehmigt|genehmigen|bewilligt|bewilligen|billigt|billigen|stimmt[^.!?]{0,120}\bzu|zugestimmt|approves?|approved)(?![\p{L}\p{N}])/iu,
  amends: /(?<![\p{L}\p{N}])(?:ändert|ändern|geändert|Änderung|amends?|amended)(?![\p{L}\p{N}])/iu,
  located_in: /\b(?:liegt|liegen|befindet|befinden|gelegen|Standort|located|situated)\b/iu,
  cooperates_with: /\b(?:kooperiert|kooperieren|Kooperation|zusammenarbeitet|Zusammenarbeit|cooperates?|cooperation)\b/iu,
  cites: /(?<![\p{L}\p{N}])(?:gemäß|nach|laut|auf Grundlage|verweist|Bezug|cites?|pursuant)(?![\p{L}\p{N}])/iu,
};
const negative = /\b(?:nicht|kein(?:e[rmns]?)?|weder|not|never|no)\b/iu;
const prospective = /\b(?:soll(?:en|te|ten)?|plant|planen|geplant|vorgesehen|beabsichtigt|künftig|zukünftig|voraussichtlich|Entwurf|Vorschlag|beantragt|will|planned|proposed)\b|\b(?:wird|werden)\b[^.!?]{0,160}(?<![\p{L}\p{N}])(?:betreiben|fördern|finanzieren|errichten|umsetzen|ändern|kooperieren|beschließen|entscheiden|genehmigen|bewilligen|billigen|zustimmen)(?![\p{L}\p{N}])/iu;
const conditional = /\b(?:wenn|falls|sofern|vorbehaltlich|unter der Bedingung|if|subject to)\b/iu;
const historical = /\b(?:ehemalig(?:e[rmns]?)?|früher|damals|formerly|previously)\b/iu;
const dated = /\b(ab|am|zum|bis|seit|im Jahr|in)\s+(?:\d{1,2}\.\s*\d{1,2}\.\s*)?((?:19|20)\d{2})(?:-\d{2}-\d{2})?\b/giu;
const actualDecision = /(?<![\p{L}\p{N}])(?:beschließt|beschloss|beschlossen|entscheidet|entschieden|decides|decided)(?![\p{L}\p{N}])/iu;
const actualApproval = /(?<![\p{L}\p{N}])(?:genehmigt|bewilligt|billigt|stimmt[^.!?]{0,120}\bzu|zugestimmt|approves|approved)(?![\p{L}\p{N}])/iu;
const actualImplementation = /(?<![\p{L}\p{N}])(?:realisiert|errichtet|umgesetzt|setzt[^.!?]{0,50}\bum|durchgeführt|führt[^.!?]{0,50}\bdurch|implements|implemented)(?![\p{L}\p{N}])/iu;
const relationHash = (value: string) => createHash('sha256').update(value).digest('hex');
const planningQualifiers = new Set(['planned', 'proposed', 'conditional', 'negated', 'historical']);
function planningPredicate(relation: GraphClaims['relations'][number]): boolean {
  return predicates.plans.test(relation.predicateQuote) || (planningQualifiers.has(relation.modality) && prospective.test(relation.quote) && predicates.implements.test(relation.predicateQuote));
}

/** Canonicalize only the existing predicate in its own quotation. This is not admission or a role judgment. */
export function normalizeRelationActions<T extends GraphClaims>(claims: T): { claims: T; normalization: RelationActionNormalization | null } {
  const mappings: RelationActionNormalization['mappings'] = [];
  const relations = claims.relations.map((relation, index) => {
    if (!relation.quote.includes(relation.predicateQuote)) return relation;
    const actions = (['plans', 'decides', 'approves', 'implements'] as const).filter(type => type === 'plans' ? planningPredicate(relation) : predicates[type].test(relation.predicateQuote));
    // Planning an execution is still planning; independent decision/approval mixtures remain ambiguous.
    if (actions.includes('plans') && actions.includes('implements') && planningQualifiers.has(relation.modality)) actions.splice(actions.indexOf('implements'), 1);
    if (actions.length !== 1) return relation;
    const type = actions[0];
    // A correctly typed non-action relation is not displaced by an embedded action.
    if (!['plans', 'decides', 'approves', 'implements'].includes(relation.type) && predicates[relation.type].test(relation.predicateQuote)) return relation;
    let modality = relation.modality;
    const qualified = negative.test(relation.quote) || conditional.test(relation.quote) || relation.conditions !== null || historical.test(relation.quote);
    if (!qualified && !['proposed', 'conditional', 'negated', 'historical'].includes(modality)) {
      if (type === 'plans') modality = 'planned';
      else if (!prospective.test(relation.quote) && modality === 'asserted') {
        if (type === 'decides' && actualDecision.test(relation.predicateQuote) || type === 'approves' && actualApproval.test(relation.predicateQuote)) modality = 'decided';
        else if (type === 'implements' && actualImplementation.test(relation.predicateQuote)) modality = 'implemented';
      }
    }
    if (type === relation.type && modality === relation.modality) return relation;
    const rule = type === 'plans' ? 'explicit-planning' : type === 'decides' ? 'explicit-decision' : type === 'approves' ? 'explicit-approval' : 'explicit-implementation';
    mappings.push({ index, originalType: relation.type, originalModality: relation.modality, type, modality, rule, quoteSha256: relationHash(relation.quote), predicateQuoteSha256: relationHash(relation.predicateQuote) });
    return { ...relation, type, modality };
  });
  return mappings.length ? { claims: { ...claims, relations }, normalization: { version: RELATION_ACTION_NORMALIZATION_VERSION, mappings } } : { claims, normalization: null };
}

/** Confirmed paths mean admitted source assertions, never independently confirmed completion. */
export function relationPathEligible(relation: Pick<GraphClaims['relations'][number], 'type' | 'modality'>): boolean {
  if (relation.type === 'plans') return false;
  if (relation.type === 'decides' || relation.type === 'approves') return relation.modality === 'decided';
  if (relation.type === 'implements') return relation.modality === 'implemented';
  return relation.modality === 'asserted';
}
export function graphGroundingChecks(claims: GraphClaims, text: string) {
  const mentions = new Map(claims.entities.map(entity => [entity.mentionId, entity]));
  const exact = (value: string) => text.includes(value);
  const checks = [
    { id: 'graph_mentions', passed: mentions.size === claims.entities.length && claims.entities.every(entity => exact(entity.quote) && quotedName(entity.quote,entity.name) && !/\b(?:Herr|Frau|Herrn|Dr\.)\s/u.test(entity.name)), reason: 'Unique typed non-person mentions have exact source quotations and whitespace-equivalent labels; no metadata-only entities.' },
    { id: 'graph_identifiers', passed: claims.entities.every(entity => entity.identifiers.every(id => exact(id.quote) && quotedName(id.quote,entity.name) && [id.value,id.namespace,id.issuer].every(value=>quotedName(id.quote,value))) && new Set(entity.identifiers.map(id => JSON.stringify([id.namespace, id.issuer]))).size === entity.identifiers.length), reason: 'Identifier, namespace, issuer and named entity share a source quote; conflicting identifiers within one namespace are rejected.' },
    { id: 'graph_relations', passed: claims.relations.every(relation => {
      const from = mentions.get(relation.fromMention), to = mentions.get(relation.toMention);
      return from && to && from.mentionId !== to.mentionId && exact(relation.quote) && quotedName(relation.quote,from.name) && quotedName(relation.quote,to.name) && relation.quote.includes(relation.predicateQuote) && (relation.type === 'plans' ? planningPredicate(relation) : predicates[relation.type].test(relation.predicateQuote)) && (!relation.time || exact(relation.time.quote) && relation.quote.includes(relation.time.quote) && relation.time.quote.includes(relation.time.text)) && (relation.conditions === null || relation.quote.includes(relation.conditions));
    }), reason: 'Both named endpoints and an explicit typed predicate occur in one contiguous quotation; time and conditions are quoted, not metadata-derived.' },
    { id: 'graph_modality', passed: claims.relations.every(relation => {
      if (relation.type === 'plans' && !['planned', 'proposed', 'conditional', 'negated', 'historical'].includes(relation.modality)) return false;
      if (relation.type === 'implements' && ['planned', 'proposed'].includes(relation.modality)) return false;
      if (relation.modality === 'decided' && !((relation.type === 'decides' && actualDecision.test(relation.predicateQuote)) || (relation.type === 'approves' && actualApproval.test(relation.predicateQuote)))) return false;
      if (relation.modality === 'implemented' && !(relation.type === 'implements' && actualImplementation.test(relation.predicateQuote))) return false;
      if (relation.modality === 'asserted' && ['plans', 'decides', 'approves', 'implements'].includes(relation.type)) return false;
      const dates = [...relation.quote.matchAll(dated)].map(match => ({ marker: match[1].toLocaleLowerCase('de'), year: Number(match[2]) }));
      if (dates.length && relation.time === null) return false;
      const documentYear = claims.documentDate ? Number(claims.documentDate.slice(0, 4)) : null;
      if (documentYear !== null && dates.some(date => date.marker !== 'bis' && date.year > documentYear) && ['asserted', 'decided', 'implemented'].includes(relation.modality)) return false;
      if (negative.test(relation.quote)) return relation.modality === 'negated';
      if (conditional.test(relation.quote) || relation.conditions !== null) return relation.modality === 'conditional' && relation.conditions !== null;
      if (prospective.test(relation.quote)) return ['planned', 'proposed'].includes(relation.modality);
      if (historical.test(relation.quote) || /(?:^|\s)betrieb(?:\s|$)/u.test(relation.predicateQuote)) return relation.modality === 'historical' && relation.time !== null;
      return relation.modality !== 'negated' && (relation.modality !== 'historical' || relation.time !== null);
    }), reason: 'Explicit planning, decision and implementation remain distinct. Negation, future/proposal and conditions cannot enter factual paths; historical claims retain quoted time. Typed lexical support is not a role or success judgment.' },
  ];
  return checks;
}

export const graphPromptInstructions = ` Joint graph in this SAME response: entities use local mentionIds, not global IDs. Copy source name/type/quote; no people. Preserve legal forms and distinct laws/amendments. identifiers=[] unless ONE identifier.quote contains entity name AND literal value, namespace and issuer; a printed plan number supplies neither namespace nor issuer. relations=[] if unsupported. Both distinct endpoint mentionIds must exist; ONE relation.quote contains BOTH names and explicit action. predicateQuote copies the COMPLETE relation verb/phrase, not an endpoint or truncated verb: operates ("betreibt"), funds ("finanziert"), implements ("umgesetzt"), plans ("plant den Ausbau"), decides ("beschließt"), approves ("genehmigt"), amends ("ändert"), located_in ("liegt"), cooperates_with ("kooperiert"), cites ("gemäß"). Explicit planning and quoted intent to construct are plans/planned, never implements/planned or implements/implemented. Actual decisions/approvals are decides/decided or approves/decided, NOT construction, operation or spending. Actual execution is implements/implemented, describing only quoted execution, not inferred completion or success. Non-action facts retain asserted. Future/proposed actions retain planned/proposed; conditional/negated/historical qualifiers override factual modalities. Words alone do not prove roles: "beschließt den Wirtschaftsplan" is NOT operates, "Erhalt des Zuschlages" NOT implements, "als Satzung beschlossen" NOT cites, "der Stadt" NOT located_in. Decisions/approvals need the named decision-maker/approver and object in the correct direction, not merely passive wording. Never force headings, ownership or co-occurrence into a type. Omit edges needing pronouns, absent endpoints, metadata or unsupported predicates; never invent linking words. predicateQuote/conditions/time.quote occur inside relation.quote; time.text inside time.quote. time/conditions are null only when absent; otherwise copy exact spans. Keep dates/intervals and asserted/planned/decided/implemented/proposed/conditional/negated/historical modality. Planned funding is not spending; proposals are not operation. Future starts are not factual assertions; a future "bis" end alone is not a future start. Conditional edges need quoted conditions; historical edges quoted time. Judge identity, issuer, endpoints, predicate, direction, modality, time and conditions against their own quotes, not just lexical matches. Paths prove neither causality nor success.`;
