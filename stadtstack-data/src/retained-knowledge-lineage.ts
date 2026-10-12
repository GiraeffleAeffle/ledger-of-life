import { z } from 'zod';
import { dataReleaseId, dataReleaseSchema, requireReleaseFiles } from './data-release.ts';
import { districtRegistrySchema, type DistrictRegistry } from './district-registry.ts';
import { DistrictKnowledgeRecordSchema, PublicKnowledgeRecordSchema, KNOWLEDGE_SCHEMA_VERSION, hashSchema, knowledgeEvidenceHash, type DistrictKnowledgeRecord } from './district-schema.ts';
import { normalizeGraphClaims } from './district-graph-claims.ts';
import { publicUrlIssues } from './publication-quality.ts';
import { readTextLineageArtifact, textLineageRecordSha256, textRunLineageSchema, textSchemaProjectionSchema, type TextLineageArtifact } from './text-run-lineage.ts';
import { projectRetainedHistoricalCoverage } from './retained-knowledge-coverage.ts';
import { ModelEvidenceSchema } from './district-model-contract.ts';

const count = z.number().int().nonnegative();
const clock = z.iso.datetime({ offset: true });
const modelSchema = ModelEvidenceSchema;
const memberSchema = <T extends string>(path: T) => z.object({ path: z.literal(path), sha256: hashSchema, bytes: count }).strict();
const originSchema = z.object({
  recordId: z.string().min(1), outputRecordIndex: count, outputArtifactSha256: hashSchema,
  originalRecordSha256: hashSchema, originalEvidenceHash: hashSchema, projectedEvidenceHash: hashSchema, currentEvidenceHash: hashSchema, currentRecordSha256: hashSchema,
  municipalityId: z.string().min(1), sourceSha256: hashSchema, sourceIds: z.array(z.string().min(1)).min(1),
  registrySourcesSha256: hashSchema,
  model: modelSchema, extractionResponseSha256: hashSchema, judgeResponseSha256: hashSchema,
  promptSha256: hashSchema, judgePromptSha256: hashSchema, extractedAt: clock, evaluatedAt: clock,
  schemaProjection: textSchemaProjectionSchema.nullable(),
}).strict();
/** A publication baseline is not an extraction run. No invented run ID or group inventory. */
export const RetainedKnowledgeLineageSchema = z.object({
  schemaVersion: z.literal('stadtstack-retained-knowledge-lineage-v1'), releaseId: hashSchema, manifestSha256: hashSchema,
  members: z.object({ records: memberSchema('knowledge/records.json'), coverage: memberSchema('knowledge/coverage.json'), registry: memberSchema('knowledge/registry.json') }).strict(),
  artifactClocks: z.object({ manifest: clock, records: clock, coverage: clock, registry: clock }).strict(),
  recordsSchemaVersion: z.enum(['stadtstack-knowledge-v2', 'stadtstack-knowledge-v3']), schemaProjection: textSchemaProjectionSchema.nullable(),
  historicalCoverageSha256: hashSchema, selectedRecordOrigins: z.array(originSchema),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.selectedRecordOrigins.map(origin => origin.recordId)).size !== value.selectedRecordOrigins.length || new Set(value.selectedRecordOrigins.map(origin => origin.outputRecordIndex)).size !== value.selectedRecordOrigins.length) ctx.addIssue({ code: 'custom', message: 'Duplicate retained selected record origin' });
  for (const origin of value.selectedRecordOrigins) {
    if (origin.outputArtifactSha256 !== value.members.records.sha256 || origin.currentEvidenceHash !== origin.projectedEvidenceHash || textLineageRecordSha256(origin.schemaProjection) !== textLineageRecordSha256(value.schemaProjection)) ctx.addIssue({ code: 'custom', message: 'Retained selected origin binding mismatch' });
  }
  if (value.schemaProjection && value.recordsSchemaVersion !== 'stadtstack-knowledge-v2') ctx.addIssue({ code: 'custom', message: 'Retained schema projection requires knowledge-v2 originals' });
});
export type RetainedKnowledgeLineage = z.infer<typeof RetainedKnowledgeLineageSchema>;
export type RetainedKnowledgeRecordOrigin = z.infer<typeof originSchema>;
export type RetainedKnowledgePublicationInput = {
  artifacts: { manifest: TextLineageArtifact; records: TextLineageArtifact; coverage: TextLineageArtifact; registry: TextLineageArtifact };
  recordIds: readonly string[];
  schemaProjection?: z.infer<typeof textSchemaProjectionSchema>;
};
const coverageSchema = z.object({
  schemaVersion: z.enum(['stadtstack-district-coverage-v3', 'stadtstack-district-coverage-v4', 'stadtstack-district-coverage-v5']), generatedAt: clock,
  extractionRun: z.object({ generatedAt: clock, assignmentMode: z.enum(['balanced', 'codex-only']), corpusSha256: hashSchema, registrySha256: hashSchema, promptContractSha256: hashSchema, schemaSha256: hashSchema, selection: z.enum(['all_at_run_start', 'bounded_per_municipality']), maxDocumentsPerMunicipality: count.nullable(), availableDocumentGroupsAtRunStart: count, attemptedDocumentGroups: count, pendingDocumentGroupsAtRunStart: count }).strict().optional(),
  municipalities: z.array(z.object({ id: z.string(), ags: z.string(), districtId: z.string(), publishedRecords: count, sources: z.array(z.object({ sourceId: z.string(), kind: z.string(), publishedRecords: count }).passthrough()) }).passthrough()),
  models: z.array(ModelEvidenceSchema.safeExtend({ publishedRecords: count, faithfulnessThreshold: z.literal(0.8) })),
  textLineage: textRunLineageSchema.nullable().optional(),
  retainedPublication: RetainedKnowledgeLineageSchema.nullable().optional(),
}).passthrough();
export type AuthenticatedRetainedKnowledgePublication = {
  input: RetainedKnowledgePublicationInput;
  records: DistrictKnowledgeRecord[];
  recordIndexes: number[];
  registry: DistrictRegistry;
  coverage: z.infer<typeof coverageSchema>;
  lineage: RetainedKnowledgeLineage;
};
export type RetainedKnowledgeComposition = { baseline: AuthenticatedRetainedKnowledgePublication; selectedRecordOrigins: RetainedKnowledgeRecordOrigin[] };
const modelKey = (model: z.infer<typeof modelSchema>) => textLineageRecordSha256({ provider: model.provider, model: model.model, tool: model.tool, toolVersion: model.toolVersion, modelIdentitySha256: model.modelIdentitySha256, modelIdentityBasis: model.modelIdentityBasis });

/** Validates sealed public bytes only. Current host/opt-out admission belongs to managed intake. */
export function authenticateRetainedKnowledgePublication(input: RetainedKnowledgePublicationInput): AuthenticatedRetainedKnowledgePublication {
  if (!input.recordIds.length) throw Error('Retained admission inventory must select at least one original text record');
  const manifest = dataReleaseSchema.parse(readTextLineageArtifact(input.artifacts.manifest));
  if (manifest.id !== dataReleaseId(manifest.files)) throw Error('Retained publication manifest identity mismatch');
  requireReleaseFiles(manifest, ['knowledge/records.json', 'knowledge/coverage.json', 'knowledge/registry.json']);
  const members = {} as RetainedKnowledgeLineage['members'];
  for (const kind of ['records', 'coverage', 'registry'] as const) {
    const artifact = input.artifacts[kind], member = manifest.files.find(file => file.path === `knowledge/${kind}.json`)!;
    const bytes = typeof artifact.bytes === 'string' ? Buffer.byteLength(artifact.bytes, 'utf8') : artifact.bytes.byteLength;
    if (member.sha256 !== artifact.sha256 || member.bytes !== bytes) throw Error('Retained publication member binding mismatch');
    Object.assign(members, { [kind]: member });
  }
  const registryRaw = readTextLineageArtifact(input.artifacts.registry);
  districtRegistrySchema.parse(registryRaw);
  const registry = registryRaw as DistrictRegistry;
  const coverageRaw = readTextLineageArtifact(input.artifacts.coverage);
  coverageSchema.parse(coverageRaw);
  // Keep the complete sealed public members privately, not a lossy schema projection.
  const coverage = coverageRaw as z.infer<typeof coverageSchema>;
  const output = z.object({ schemaVersion: z.enum(['stadtstack-knowledge-v2', 'stadtstack-knowledge-v3']), generatedAt: clock, records: z.array(z.unknown()) }).passthrough().parse(readTextLineageArtifact(input.artifacts.records));
  const schemaProjection = input.schemaProjection === undefined ? null : textSchemaProjectionSchema.parse(input.schemaProjection);
  if (schemaProjection && (KNOWLEDGE_SCHEMA_VERSION as string) !== 'stadtstack-knowledge-v3') throw Error('Explicit text schema projection requires a knowledge-v3 consumer');
  if (schemaProjection && output.schemaVersion !== 'stadtstack-knowledge-v2') throw Error('Explicit text schema projection requires an unmarked authenticated knowledge-v2 publication');
  if (output.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION && !schemaProjection) throw Error('Retained publication schema requires an explicit supported projection');
  const records:DistrictKnowledgeRecord[]=[],recordIndexes:number[]=[];
  const allRecords=output.records.map((raw,outputRecordIndex)=>{
    const candidate=raw as DistrictKnowledgeRecord;
    if(candidate?.kind==='structured')return PublicKnowledgeRecordSchema.parse(raw);
    const original=raw as DistrictKnowledgeRecord;
    if(original.verification?.evidenceHash!==knowledgeEvidenceHash(original))throw Error('Original retained record evidence hash mismatch');
    const validationRecord=schemaProjection?{...original,kind:'text_model' as const,verification:{...original.verification,kind:'text_model' as const}}:original;
    const validation=DistrictKnowledgeRecordSchema.safeParse(validationRecord);
    if(!validation.success&&validation.error.issues.some(issue=>issue.code!=='custom'||issue.message!=='Pipeline graph identity mismatch'))throw validation.error;
    if(original.verification.status!=='auto-verified')throw Error('Retained publication cannot admit an original candidate');
    if(schemaProjection&&(Object.hasOwn(original,'kind')||Object.hasOwn(original.verification,'kind')))throw Error('Retained schema projection requires unmarked originals');
    const city=registry.municipalities.find(city=>city.id===original.municipalityId);
    if(!city||city.ags!==original.ags||city.districtId!==original.districtId||original.sources.some(source=>source.sha256!==original.extraction.inputSha256||!city.sources.some(registered=>registered.id===source.id&&registered.kind===source.sourceType)))throw Error('Original retained record source/registry binding mismatch');
    if(publicUrlIssues(original).length||original.documentDate===null&&original.stageDate===null&&!original.stages.some(event=>event.date!==null))throw Error('Retained publication contains a publication-withheld record');
    records.push(original);
    recordIndexes.push(outputRecordIndex);
    return original;
  });
  const ids=new Set<string>();
  for(const record of allRecords){if(ids.has(record.id))throw Error('Duplicate retained publication record ID');ids.add(record.id);}
  if(allRecords.some(record=>record.kind==='structured'&&record.verification.status!=='auto-verified'))throw Error('Retained publication cannot admit an original candidate');
  const allowed = new Set(input.recordIds),textIds=new Set(records.map(record=>record.id));
  if (allowed.size !== input.recordIds.length || input.recordIds.some(id => !textIds.has(id))) throw Error('Retained admission inventory must contain unique exact original text record IDs');
  const cities = new Map(coverage.municipalities.map(city => [city.id, city]));
  if (cities.size !== coverage.municipalities.length || cities.size !== registry.municipalities.length) throw Error('Retained publication municipality inventory mismatch');
  const sourcesOf=(record:typeof allRecords[number])=>record.kind==='structured'?[record.source,...record.supportingSources]:record.sources;
  for (const city of registry.municipalities) {
    const covered=cities.get(city.id),matching=allRecords.filter(record=>record.municipalityId===city.id),matchingText=records.filter(record=>record.municipalityId===city.id),matchingStructured=matching.length-matchingText.length;
    if(!covered||covered.ags!==city.ags||covered.districtId!==city.districtId||covered.publishedRecords!==matching.length||covered.sources.length!==city.sources.length||new Set(covered.sources.map(source=>source.sourceId)).size!==city.sources.length||coverage.schemaVersion==='stadtstack-district-coverage-v5'&&(covered.textModelRecords!==matchingText.length||covered.structuredRecords!==matchingStructured))throw Error('Retained publication record accounting mismatch');
    for(const source of covered.sources)if(!city.sources.some(item=>item.id===source.sourceId&&item.kind===source.kind)||source.publishedRecords!==matching.filter(record=>sourcesOf(record).some(item=>item.id===source.sourceId)).length)throw Error('Retained publication source accounting mismatch');
  }
  const models = new Map(coverage.models.map(model => [modelKey(model), model]));
  if (models.size !== coverage.models.length || records.some(record => !models.has(modelKey(record.extraction)))) throw Error('Retained publication model receipt binding mismatch');
  for (const [identity, model] of models) if (!model.publishedRecords || model.publishedRecords !== records.filter(record => modelKey(record.extraction) === identity).length) throw Error('Retained publication model receipt binding mismatch');
  const historical = coverage.extractionRun;
  if (coverage.schemaVersion === 'stadtstack-district-coverage-v3') {
    if (!historical || historical.availableDocumentGroupsAtRunStart !== historical.attemptedDocumentGroups + historical.pendingDocumentGroupsAtRunStart || (historical.selection === 'bounded_per_municipality') !== (historical.maxDocumentsPerMunicipality !== null) || historical.maxDocumentsPerMunicipality === 0) throw Error('Retained historical extraction summary mismatch');
  } else {
    if (records.length && !coverage.textLineage && !coverage.retainedPublication) throw Error('Retained v4/v5 publication requires actual text or retained lineage');
    const origins = [...(coverage.textLineage?.selectedRecordOrigins ?? []), ...(coverage.retainedPublication?.selectedRecordOrigins ?? [])];
    const byId = new Map(origins.map(origin => [origin.recordId, origin]));
    if (byId.size !== origins.length || byId.size !== records.length) throw Error('Retained v4/v5 publication text origin inventory mismatch');
    for (const record of records) {
      const origin = byId.get(record.id);
      if (!origin || origin.currentEvidenceHash !== record.verification.evidenceHash || origin.municipalityId !== record.municipalityId || origin.sourceSha256 !== record.extraction.inputSha256 || modelKey(origin.model) !== modelKey(record.extraction) || origin.extractionResponseSha256 !== record.extraction.responseSha256 || origin.judgeResponseSha256 !== record.verification.faithfulness.responseSha256 || origin.promptSha256 !== record.extraction.promptSha256 || origin.judgePromptSha256 !== record.extraction.judgePromptSha256) throw Error('Retained v4 publication origin evidence mismatch');
      if ('currentRecordSha256' in origin && (origin.currentRecordSha256 !== textLineageRecordSha256(record) || origin.extractedAt !== record.extraction.extractedAt || origin.evaluatedAt !== record.verification.faithfulness.evaluatedAt)) throw Error('Retained v4 publication original record mismatch');
      if ('registrySourcesSha256' in origin) {
        const sourceIds = record.sources.map(source => source.id).sort();
        const registered = registry.municipalities.find(city => city.id === record.municipalityId)!.sources.filter(source => sourceIds.includes(source.id)).map(({ id, kind, url }) => ({ id, kind, url })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        if (textLineageRecordSha256([...origin.sourceIds].sort()) !== textLineageRecordSha256(sourceIds) || origin.registrySourcesSha256 !== textLineageRecordSha256(registered)) throw Error('Retained v4 publication registry source binding mismatch');
      }
    }
    if (coverage.retainedPublication && coverage.historicalCoverage !== undefined && coverage.retainedPublication.historicalCoverageSha256 !== textLineageRecordSha256(coverage.historicalCoverage)) throw Error('Retained v4 publication historical coverage mismatch');
  }
  // registrySha256 is the historical extraction pin, not necessarily the later published registry member.
  const lineage = RetainedKnowledgeLineageSchema.parse({ schemaVersion: 'stadtstack-retained-knowledge-lineage-v1', releaseId: manifest.id, manifestSha256: input.artifacts.manifest.sha256, members, artifactClocks: { manifest: manifest.generatedAt, records: output.generatedAt, coverage: coverage.generatedAt, registry: registry.generatedAt }, recordsSchemaVersion: output.schemaVersion, schemaProjection, historicalCoverageSha256: textLineageRecordSha256(projectRetainedHistoricalCoverage(coverage)), selectedRecordOrigins: [] });
  return { input, records, recordIndexes, registry, coverage, lineage };
}

/** Identity-only projection shared with native composition; original receipts are never repaired. */
export function projectKnowledgeRecordIdentity(original: DistrictKnowledgeRecord, schemaProjection?: z.infer<typeof textSchemaProjectionSchema>): DistrictKnowledgeRecord {
  if (original.verification.evidenceHash !== knowledgeEvidenceHash(original)) throw Error('Original record evidence hash mismatch');
  const graph = normalizeGraphClaims(original, { municipalityId: original.municipalityId, sourceSha256: original.extraction.inputSha256, ags: original.ags });
  const markers = schemaProjection === undefined ? {} : { kind: 'text_model' as const };
  const projected = { ...original, ...graph, ...markers, verification: { ...original.verification, ...markers } };
  projected.verification.evidenceHash = knowledgeEvidenceHash(projected);
  DistrictKnowledgeRecordSchema.parse(projected);
  return projected;
}
export function retainedKnowledgeRecordOrigin(baseline: AuthenticatedRetainedKnowledgePublication, outputRecordIndex: number, projected: DistrictKnowledgeRecord): RetainedKnowledgeRecordOrigin {
  const localIndex=baseline.recordIndexes.indexOf(outputRecordIndex),original=localIndex<0?undefined:baseline.records[localIndex];
  if (!original || !baseline.input.recordIds.includes(original.id) || textLineageRecordSha256(projectKnowledgeRecordIdentity(original, baseline.input.schemaProjection)) !== textLineageRecordSha256(projected)) throw Error('Retained selected record changes original claims or receipts');
  const extraction = original.extraction;
  const registrySourcesSha256 = textLineageRecordSha256(baseline.registry.municipalities.find(city => city.id === original.municipalityId)!.sources.filter(source => original.sources.some(item => item.id === source.id)).map(({ id, kind, url }) => ({ id, kind, url })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return originSchema.parse({ recordId: original.id, outputRecordIndex, outputArtifactSha256: baseline.lineage.members.records.sha256, originalRecordSha256: textLineageRecordSha256(original), originalEvidenceHash: original.verification.evidenceHash, projectedEvidenceHash: projected.verification.evidenceHash, currentEvidenceHash: projected.verification.evidenceHash, currentRecordSha256: textLineageRecordSha256(projected), municipalityId: original.municipalityId, sourceSha256: extraction.inputSha256, sourceIds: original.sources.map(source => source.id), registrySourcesSha256, model: { provider: extraction.provider, model: extraction.model, tool: extraction.tool, toolVersion: extraction.toolVersion, modelIdentitySha256: extraction.modelIdentitySha256, modelIdentityBasis: extraction.modelIdentityBasis }, extractionResponseSha256: extraction.responseSha256, judgeResponseSha256: original.verification.faithfulness.responseSha256, promptSha256: extraction.promptSha256, judgePromptSha256: extraction.judgePromptSha256, extractedAt: extraction.extractedAt, evaluatedAt: original.verification.faithfulness.evaluatedAt, schemaProjection: baseline.lineage.schemaProjection });
}
/** Reauthenticate the exact public bytes, including private registry/source proof, at the coverage boundary. */
export function validateRetainedKnowledgeComposition(value: RetainedKnowledgeComposition): RetainedKnowledgeComposition {
  const baseline = authenticateRetainedKnowledgePublication(value.baseline.input);
  for (const field of ['records', 'recordIndexes', 'registry', 'coverage', 'lineage'] as const) if (textLineageRecordSha256(baseline[field]) !== textLineageRecordSha256(value.baseline[field])) throw Error('Retained private provenance was changed after authentication');
  RetainedKnowledgeLineageSchema.parse({ ...baseline.lineage, selectedRecordOrigins: value.selectedRecordOrigins });
  for (const origin of value.selectedRecordOrigins) {
    const localIndex=baseline.recordIndexes.indexOf(origin.outputRecordIndex),original=localIndex<0?undefined:baseline.records[localIndex];
    if (!original) throw Error('Retained selected record index is absent');
    const expected = retainedKnowledgeRecordOrigin(baseline, origin.outputRecordIndex, projectKnowledgeRecordIdentity(original, baseline.input.schemaProjection));
    if (textLineageRecordSha256(expected) !== textLineageRecordSha256(origin)) throw Error('Retained selected record origin mismatch');
  }
  return { baseline, selectedRecordOrigins: value.selectedRecordOrigins };
}
