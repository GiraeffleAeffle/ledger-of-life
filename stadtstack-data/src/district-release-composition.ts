import { z } from 'zod';
import { normalizeGraphClaims } from './district-graph-claims.ts';
import { DistrictKnowledgeRecordSchema, KNOWLEDGE_SCHEMA_VERSION, knowledgeEvidenceHash, type DistrictKnowledgeRecord } from './district-schema.ts';
import { knowledgePublicationHold } from './district-publication.ts';
import { authenticateTextRunContribution, buildAuthenticatedTextRunLineage, textSchemaProjectionSchema, type AuthenticatedTextRunContribution, type TextRunContribution, type TextRecordSelection, type TextRunLineage } from './text-run-lineage.ts';
import { authenticateRetainedKnowledgePublication, projectKnowledgeRecordIdentity, retainedKnowledgeRecordOrigin, type RetainedKnowledgeComposition, type RetainedKnowledgePublicationInput } from './retained-knowledge-lineage.ts';

/** Admission is supplied by managed intake, not inferred from run order or document dates. */
export type DistrictTextSchemaProjection = z.infer<typeof textSchemaProjectionSchema>;
export type DistrictRunAdmission = { runId: string; recordIds: readonly string[]; schemaProjection?: DistrictTextSchemaProjection };
export type DistrictReleaseCompositionInput = {
  contributions: readonly TextRunContribution[];
  approvedRunOrder: readonly string[];
  admissions: readonly DistrictRunAdmission[];
  retainedPublication?: RetainedKnowledgePublicationInput;
  generatedAt: string;
};
export type DistrictRecordCompositionAudit = {
  runId: string;
  recordId: string;
  originalEvidenceHash: string;
  projectedEvidenceHash: string | null;
  schemaProjection: DistrictTextSchemaProjection | null;
  disposition: 'selected' | 'unselected_revision' | 'candidate' | 'withheld_by_intake';
  selectedRunId: string | null;
  selectedEvidenceHash: string | null;
};
export type DistrictRecordOrigin = {
  runId: string;
  recordIndex: number;
  recordId: string;
  municipalityId: string;
  sourceSha256: string;
  sourceIds: string[];
  originalEvidenceHash: string;
};
export type DistrictQuarantineOrigin = {
  runId: string;
  caseIndex: number;
  municipalityId: string;
  sourceId: string;
  sourceSha256: string;
  candidateRecordId: string | null;
  candidateEvidenceHash: string | null;
};
export type DistrictQuarantineCompositionAudit = DistrictQuarantineOrigin & {
  selectedRunId: string | null;
  selectedEvidenceHash: string | null;
};

type OriginalCrawlDocument = AuthenticatedTextRunContribution['crawl']['documents'][number];
type OriginalCrawlCheck = AuthenticatedTextRunContribution['crawl']['checks'][number];
export type DistrictCrawlDocumentObservations = {
  municipalityId: string; sourceId: string; documentId: string; sourceSha256: string;
  observations: Array<{ runId: string; documentIndex: number; document: OriginalCrawlDocument }>;
};
export type DistrictCrawlCheckObservation = { runId: string; checkIndex: number; check: OriginalCrawlCheck };
export type DistrictCrawlExcludedObservation = { runId: string; documentIndex: number; document: unknown };
export type DistrictReleaseComposition = {
  records: { schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION; generatedAt: string; records: DistrictKnowledgeRecord[] };
  quarantine: { schemaVersion: 'stadtstack-quarantine-v1'; generatedAt: string; cases: AuthenticatedTextRunContribution['quarantine']['cases'] };
  crawl: {
    schemaVersion: 'stadtstack-crawl-index-v1'; generatedAt: string;
    documents: OriginalCrawlDocument[]; checks: Array<OriginalCrawlCheck & { runId: string }>; excludedDocuments: unknown[];
  };
  lineage: TextRunLineage | null;
  retainedPublication: RetainedKnowledgeComposition | null;
  selections: TextRecordSelection[];
  audit: {
    schemaVersion: 'stadtstack-district-release-composition-v1'; generatedAt: string;
    selectionRule: 'latest_admitted_in_explicit_input_order'; approvedRunOrder: string[]; records: DistrictRecordCompositionAudit[];
    quarantine: DistrictQuarantineCompositionAudit[];
  };
  provenance: {
    originalContributions: readonly TextRunContribution[];
    runs: AuthenticatedTextRunContribution[]; recordOrigins: DistrictRecordOrigin[]; quarantineOrigins: DistrictQuarantineOrigin[];
    withheldRecords: Array<{ runId: string; recordIndex: number; record: DistrictKnowledgeRecord }>;
    crawlDocuments: DistrictCrawlDocumentObservations[]; crawlChecks: DistrictCrawlCheckObservation[]; crawlExcludedDocuments: DistrictCrawlExcludedObservation[];
  };
};

/**
 * Identity-only projection. Never changes a claim, source reference, clock,
 * generation identity, deterministic check, native response or judge receipt.
 * The original artifact hash is checked by intake; its record hash is checked
 * here BEFORE any derived identity can be replaced.
 */
export function projectDistrictRecordIdentity(original: DistrictKnowledgeRecord): DistrictKnowledgeRecord {
  return projectRecord(original);
}

/** Schema markers are added only after composition authenticates an explicit v2-to-v3 request. */
function projectRecord(original: DistrictKnowledgeRecord, schemaProjection?: DistrictTextSchemaProjection): DistrictKnowledgeRecord {
  if (original.verification.evidenceHash !== knowledgeEvidenceHash(original)) throw Error('Original record evidence hash mismatch');
  const graph = normalizeGraphClaims(original, { municipalityId: original.municipalityId, sourceSha256: original.extraction.inputSha256, ags: original.ags });
  const markers = schemaProjection === undefined ? {} : { kind: 'text_model' as const };
  const projected = { ...original, ...graph, ...markers, verification: { ...original.verification, ...markers } };
  projected.verification.evidenceHash = knowledgeEvidenceHash(projected);
  // Validation may reject a record, but must never repair its original gates.
  DistrictKnowledgeRecordSchema.parse(projected);
  return projected;
}

function assertApprovedOrder(input: DistrictReleaseCompositionInput): void {
  if (input.contributions.some(run => run.sourceArtifactKind !== 'native_extraction_output')) throw Error('Retained publications must use the authenticated retained-role input, not a text extraction run');
  if ((!input.contributions.length && !input.retainedPublication) || input.approvedRunOrder.length !== input.contributions.length || new Set(input.approvedRunOrder).size !== input.approvedRunOrder.length || input.contributions.some((run, index) => run.runId !== input.approvedRunOrder[index])) {
    throw Error('Contributions require a unique, explicitly approved input order');
  }
  const admittedRuns = new Set(input.admissions.map(run => run.runId));
  if (admittedRuns.size !== input.admissions.length || admittedRuns.size !== input.contributions.length || input.approvedRunOrder.some(runId => !admittedRuns.has(runId))) throw Error('Admission inventory must bind every approved run exactly once');
}

/**
 * Pure composition, never an authorization to read source bytes. Every artifact
 * and pin must come from the parent's current managed-intake authority checks.
 * Later admitted revisions win only in the explicitly approved order. This is
 * release selection, NOT evidence of real-world supersession or a new model run.
 *
 * Only `audit` and `lineage` are content-free public projections. `provenance`,
 * `records`, `quarantine` and `crawl` remain source-bearing managed data.
 */
export function composeDistrictRelease(input: DistrictReleaseCompositionInput): DistrictReleaseComposition {
  z.iso.datetime({ offset: true }).parse(input.generatedAt);
  assertApprovedOrder(input);
  const runs = input.contributions.map(authenticateTextRunContribution);
  const admissions = new Map(input.admissions.map(run => [run.runId, new Set(run.recordIds)]));
  const baseline = input.retainedPublication ? authenticateRetainedKnowledgePublication(input.retainedPublication) : null;
  const retainedRecords = new Map<string, { record: DistrictKnowledgeRecord; recordIndex: number }>();
  if (baseline) {
    const admitted = new Set(baseline.input.recordIds);
    for (const [localIndex, original] of baseline.records.entries()) if (admitted.has(original.id)) {
      const record = projectKnowledgeRecordIdentity(original, baseline.input.schemaProjection);
      if (knowledgePublicationHold(record)) throw Error('Retained selection contains a publication-withheld record');
      retainedRecords.set(original.id, { record, recordIndex: baseline.recordIndexes[localIndex] });
    }
  }
  const selected = new Map<string, TextRecordSelection>();
  const versions: DistrictRecordCompositionAudit[] = [];
  const recordOrigins: DistrictRecordOrigin[] = [];
  const quarantineOrigins: DistrictQuarantineOrigin[] = [];
  const withheldRecords: Array<{ runId: string; recordIndex: number; record: DistrictKnowledgeRecord }> = [];

  for (const run of runs) {
    const allowed = admissions.get(run.runId)!;
    const declaration = input.admissions.find(admission => admission.runId === run.runId)!;
    if (allowed.size !== declaration.recordIds.length) throw Error('Duplicate record in admission inventory');
    const schemaProjection = declaration.schemaProjection === undefined ? undefined : textSchemaProjectionSchema.parse(declaration.schemaProjection);
    if (schemaProjection !== undefined) {
      if ((KNOWLEDGE_SCHEMA_VERSION as string) !== 'stadtstack-knowledge-v3') throw Error('Explicit text schema projection requires a knowledge-v3 consumer');
      if (run.recordsSchemaVersion !== 'stadtstack-knowledge-v2' || run.records.some(record => Object.hasOwn(record, 'kind') || Object.hasOwn(record.verification, 'kind'))) throw Error('Explicit text schema projection requires an unmarked authenticated knowledge-v2 contribution');
    }
    const seen = new Set<string>();
    for (const [localIndex, original] of run.records.entries()) {
      const recordIndex = run.outputRecordIndexes[localIndex];
      if (seen.has(original.id)) throw Error('Duplicate record ID inside one original run');
      seen.add(original.id);
      recordOrigins.push({ runId: run.runId, recordIndex, recordId: original.id, municipalityId: original.municipalityId, sourceSha256: original.extraction.inputSha256, sourceIds: original.sources.map(source => source.id), originalEvidenceHash: original.verification.evidenceHash });
      const audit: DistrictRecordCompositionAudit = { runId: run.runId, recordId: original.id, originalEvidenceHash: original.verification.evidenceHash, projectedEvidenceHash: null, schemaProjection: null, disposition: 'withheld_by_intake', selectedRunId: null, selectedEvidenceHash: null };
      versions.push(audit);
      if (original.verification.status !== 'auto-verified') {
        if (allowed.has(original.id)) throw Error('Admission inventory cannot promote an original candidate');
        audit.disposition = 'candidate';
        withheldRecords.push({ runId: run.runId, recordIndex, record: original });
        continue;
      }
      // Even an omitted revision cannot use projection to conceal false gates.
      const projected = projectRecord(original, schemaProjection);
      audit.projectedEvidenceHash = projected.verification.evidenceHash;
      audit.schemaProjection = schemaProjection ?? null;
      if (!allowed.has(original.id)) {
        withheldRecords.push({ runId: run.runId, recordIndex, record: original });
        continue;
      }
      if (knowledgePublicationHold(projected)) throw Error('Admission inventory contains a publication-withheld record');
      audit.disposition = 'unselected_revision';
      selected.set(original.id, { runId: run.runId, recordId: original.id, originalEvidenceHash: original.verification.evidenceHash, projectedRecord: projected, ...(schemaProjection === undefined ? {} : { schemaProjection }) });
      const retained = retainedRecords.get(original.id);
      if (retained && (retained.record.municipalityId !== projected.municipalityId || retained.record.ags !== projected.ags || retained.record.caseKey !== projected.caseKey)) throw Error('Native revision changes retained record identity');
      retainedRecords.delete(original.id);
    }
    if ([...allowed].some(id => !seen.has(id))) throw Error('Admission inventory references an absent original record');
    for (const [caseIndex, item] of run.quarantine.cases.entries()) {
      const candidate = item.candidate as DistrictKnowledgeRecord | undefined;
      quarantineOrigins.push({ runId: run.runId, caseIndex, municipalityId: item.municipalityId, sourceId: item.sourceId, sourceSha256: item.sourceSha256, candidateRecordId: candidate?.id ?? null, candidateEvidenceHash: candidate?.verification.evidenceHash ?? null });
    }
  }

  const selections = [...selected.values()].sort((left, right) => left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0);
  for (const version of versions) {
    const selection = selected.get(version.recordId);
    if (!selection) continue;
    version.selectedRunId = selection.runId;
    version.selectedEvidenceHash = selection.projectedRecord.verification.evidenceHash;
    if (version.disposition === 'unselected_revision' && version.runId === selection.runId) version.disposition = 'selected';
  }
  const quarantineAudit = quarantineOrigins.map(origin => {
    const selection = origin.candidateRecordId === null ? undefined : selected.get(origin.candidateRecordId);
    return { ...origin, selectedRunId: selection?.runId ?? null, selectedEvidenceHash: selection?.projectedRecord.verification.evidenceHash ?? null };
  });
  const mergedCrawl = mergeCrawlObservations(runs, input.generatedAt);
  const lineage = runs.length ? buildAuthenticatedTextRunLineage(runs, selections, input.generatedAt) : null;
  const retainedPublication = baseline ? { baseline, selectedRecordOrigins: [...retainedRecords.values()].map(({ record, recordIndex }) => retainedKnowledgeRecordOrigin(baseline, recordIndex, record)).sort((a, b) => a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0) } : null;
  const records = [...retainedRecords.values()].map(item => item.record).concat(selections.map(selection => selection.projectedRecord)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    records: { schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: input.generatedAt, records },
    quarantine: { schemaVersion: 'stadtstack-quarantine-v1' as const, generatedAt: input.generatedAt, cases: runs.flatMap(run => run.quarantine.cases) },
    crawl: mergedCrawl.crawl,
    lineage,
    retainedPublication,
    selections,
    audit: { schemaVersion: 'stadtstack-district-release-composition-v1' as const, generatedAt: input.generatedAt, selectionRule: 'latest_admitted_in_explicit_input_order' as const, approvedRunOrder: [...input.approvedRunOrder], records: versions, quarantine: quarantineAudit },
    provenance: { originalContributions: input.contributions, runs, recordOrigins, quarantineOrigins, withheldRecords, crawlDocuments: mergedCrawl.documents, crawlChecks: mergedCrawl.checks, crawlExcludedDocuments: mergedCrawl.excludedDocuments },
  };
}

/** Preserve every observation; never turn overlapping frontier counts into a union. */
function mergeCrawlObservations(runs: readonly AuthenticatedTextRunContribution[], generatedAt: string) {
  const documents: DistrictCrawlDocumentObservations[] = [];
  const byIdentity = new Map<string, number>();
  const checks: DistrictCrawlCheckObservation[] = [];
  const excludedDocuments: DistrictCrawlExcludedObservation[] = [];
  for (const run of runs) {
    for (const [documentIndex, document] of run.crawl.documents.entries()) {
      // A repeated source byte group is one coverage group, but different source
      // aliases/URLs remain distinct document representations and observations.
      const key = JSON.stringify([document.municipalityId, document.sourceId, document.id, document.sha256, document.url ?? null]);
      let index = byIdentity.get(key);
      if (index === undefined) {
        index = documents.length;
        byIdentity.set(key, index);
        documents.push({ municipalityId: document.municipalityId, sourceId: document.sourceId, documentId: document.id, sourceSha256: document.sha256, observations: [] });
      }
      documents[index].observations.push({ runId: run.runId, documentIndex, document });
    }
    for (const [checkIndex, check] of run.crawl.checks.entries()) checks.push({ runId: run.runId, checkIndex, check });
    const excluded = run.crawl.excludedDocuments;
    if (excluded !== undefined) {
      if (!Array.isArray(excluded)) throw Error('Invalid original excluded document inventory');
      for (const [documentIndex, document] of excluded.entries()) excludedDocuments.push({ runId: run.runId, documentIndex, document });
    }
  }
  return {
    crawl: {
      schemaVersion: 'stadtstack-crawl-index-v1' as const,
      generatedAt,
      // The representative is an actual observation, not a merged/new receipt.
      documents: documents.map(document => document.observations[0].document),
      checks: checks.map(({ runId, check }) => ({ ...check, runId })),
      excludedDocuments: excludedDocuments.map(observation => observation.document),
    },
    documents,
    checks,
    excludedDocuments,
  };
}

