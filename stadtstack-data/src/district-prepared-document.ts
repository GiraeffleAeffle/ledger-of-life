import { readFile, writeFile, mkdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { extractDocumentText, runDocumentCommand, MAX_DOCUMENT_BYTES, type DocumentCommand } from './district-document.ts';
import { SourceAccessPolicySchema, assertSubscriptionSourcePolicy, sha256, hashSchema } from './district-schema.ts';
import { collectParserToolVersions, parserOutputContractSha256, readParserReview, PARSER_ISOLATION_VERSION, type ParserTool } from './district-parser-isolation.ts';
import {contractSourceManifest,type ContractSourceHash} from './district-contract-source.ts';
import type { CivicPolicyOptions, ManagedSourceBinding, ManagedAcquisitionLaneOptions } from './civic-opt-out.ts';
import type { ParserSourceContext } from './district-parser-isolation.ts';
export const PREPARED_DOCUMENT_VERSION = 'district-prepared-v2';
export const PREPARED_VM_ROOT = '/home/max/civic-knowledge-slice/stadtstack-data/cache/districts/owner-policy-2026-10-11/prepared';
const MAX_PREPARED_BYTES = 6 * 1024 * 1024;
const ReferenceSchema = z.object({ id: z.string().min(1), url: z.url(), sha256: hashSchema, retrievedAt: z.iso.datetime(), locator: z.string().min(1), mimeType: z.string().min(1), sourceType: z.enum(['council', 'participation', 'gazette', 'website', 'structured']), policy: SourceAccessPolicySchema }).strict();
export type PreparedSourceReference = z.infer<typeof ReferenceSchema>;
const ToolVersionsSchema = z.record(z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/), z.string().min(1).max(300));
export const PreparedDocumentSchema = z.object({
  version: z.literal(PREPARED_DOCUMENT_VERSION), municipalityId: z.string().regex(/^[a-z0-9-]+$/), sourceSha256: hashSchema, sourceBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES), mimeType: z.string().min(1), references: z.array(ReferenceSchema).min(1),
  extractorSha256: hashSchema, toolVersions: ToolVersionsSchema, text: z.string().min(40), textSha256: hashSchema, offsetUnit: z.literal('utf16_code_units'), textLength: z.number().int().nonnegative(),
  method: z.enum(['pdf_text', 'pdf_ocr', 'html', 'text', 'json', 'xml', 'zip_xml']), ocrUsed: z.boolean(), limitations: z.array(z.string()), receiptSha256: hashSchema,
}).strict();
export type PreparedDocument = z.infer<typeof PreparedDocumentSchema>;
export type PreparedExpectation = { receiptSha256: string; municipalityId: string; sourceSha256: string; extractorSha256: string; references: PreparedSourceReference[]; toolVersions: Record<string, string> };
export interface PreparationInput {
  bytes: Uint8Array; municipalityId: string; references: PreparedSourceReference[]; mimeType: string;
  extractorSha256: string; toolVersions: Record<string, string>;
}
export interface ManagedPreparationInput extends PreparationInput {
  managedRoot: string; policy: CivicPolicyOptions; sourceBindings: ManagedSourceBinding[]; signal?: AbortSignal;
}
/** Same text alone is not the same authorized cache context. */
export interface PreparedCacheContext { preparedReceiptSha256: string; references: Array<{ id: string; url: string; sha256: string }> }
export function preparedCacheContext(receiptSha256: string, references: PreparedSourceReference[]): PreparedCacheContext {
  hashSchema.parse(receiptSha256);
  if (!references.length) throw Error('Prepared cache context requires source references');
  const inventory = new Map<string, { id: string; url: string; sha256: string }>();
  for (const reference of references) {
    const source = { id: reference.id, url: reference.url, sha256: hashSchema.parse(reference.sha256) };
    inventory.set(JSON.stringify([source.id, source.url, source.sha256]), source);
  }
  return { preparedReceiptSha256: receiptSha256, references: [...inventory].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, source]) => source) };
}
export type PreparedArtifactBinding = Extract<ManagedSourceBinding, { kind: 'prepared_source' }> & { independentAllowed: boolean };
/** Projection of an actual GENERATED receipt; never an acquisition receipt substitute before parsing. */
export function preparedSourceBindings(references: PreparedSourceReference[], receiptSha256: string): PreparedArtifactBinding[] {
  hashSchema.parse(receiptSha256);
  const bindings = new Map<string, PreparedArtifactBinding>();
  for (const reference of references) {
    const key = JSON.stringify([reference.id, reference.url, reference.sha256]);
    if (!bindings.has(key)) bindings.set(key, { kind: 'prepared_source', url: reference.url, sourceSha256: reference.sha256, observationId: reference.id, receiptSha256, independentAllowed: true });
  }
  return [...bindings.values()];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
function checkedReferences(references: PreparedSourceReference[], sourceSha256: string, mimeType: string) {
  return references.map(raw => {
    const reference = ReferenceSchema.parse(raw);
    if (reference.sha256 !== sourceSha256 || reference.mimeType !== mimeType) throw Error('Prepared source reference differs from source bytes/MIME');
    assertSubscriptionSourcePolicy(reference.policy, reference);
    return reference;
  }).sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
}
/** Record locators may select spans; all other source identity/policy fields must
 * belong to the actual prepared receipt, never a source inferred from payload JSON. */
export function assertPreparedReferenceMembership(references: readonly PreparedSourceReference[], expected: readonly PreparedSourceReference[]): void {
  const identity = (reference: PreparedSourceReference) => { const { locator: _locator, ...source } = ReferenceSchema.parse(reference); return canonical(source); };
  const allowed = new Set(expected.map(identity));
  if (references.some(reference => !allowed.has(identity(reference)))) throw Error('Source reference differs from authenticated prepared context');

}
export async function assertPreparedSourcesActive(references: PreparedSourceReference[], options: CivicPolicyOptions = {}): Promise<void> {
  // Host-only authority modules are deliberately absent from the credential-free parser image.
  const { assertCivicPolicyAuthority, assertHostNotOptedOut } = await import('./civic-opt-out.ts');
  await assertCivicPolicyAuthority(options);
  const hosts = new Set<string>();
  for (const reference of references) {
    assertSubscriptionSourcePolicy(reference.policy, reference);
    const host = new URL(reference.url).hostname;
    if (!hosts.has(host)) { await assertHostNotOptedOut(reference.url, options); hosts.add(host); }
  }
}
export async function preparationExtractorSha256(hash?:ContractSourceHash): Promise<string> {
  // Mixed preparation/schema modules remain conservative semantic dependencies.
  const files=['district-document.ts','district-prepared-document.ts','district-preparation-run.ts','district-schema.ts','district-contract-source.ts'];
  return sha256(canonical({sourceFiles:await contractSourceManifest(files,hash),parserOutput:await parserOutputContractSha256(hash)}));
}
export async function collectPreparationToolVersions(mimeType: string, sourceContext?: ParserSourceContext): Promise<Record<string, string>> {
  const tools: ParserTool[] = mimeType.split(';')[0] === 'application/pdf' ? ['pdfinfo', 'pdftotext', 'pdftoppm', 'tesseract'] : /zip/i.test(mimeType) ? ['python3'] : ['node'];
  const review = await readParserReview();
  return { node: process.versions.node, parser_isolation: PARSER_ISOLATION_VERSION, parser_image: review.imageId, parser_contract: await parserOutputContractSha256(), ...await collectParserToolVersions(tools, sourceContext) };
}
export async function readAuthorizedSourceBytes(rawRoot: string, path: string, expectedSha256: string, policy: CivicPolicyOptions = {}): Promise<Uint8Array> {
  hashSchema.parse(expectedSha256);
  const [root, actual] = await Promise.all([realpath(rawRoot), realpath(path)]);
  const contained = relative(root, actual);
  if (!contained || contained.startsWith('..') || isAbsolute(contained)) throw Error('Source path escapes authorized raw root');
  // Reading original source bytes is a host-only admitted-content operation.
  const { assertManagedSourceReadable } = await import('./civic-opt-out.ts');
  await assertManagedSourceReadable(actual, policy);
  const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_DOCUMENT_BYTES) throw Error('Source byte limit exceeded');
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await handle.stat(), bytes = buffer.subarray(0, total);
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || sha256(bytes) !== expectedSha256) throw Error('Source bytes differ from frozen index');
    await assertManagedSourceReadable(actual, policy);
    return bytes;
  } finally { await handle.close(); }
}
export function prepareDocument(input: ManagedPreparationInput): Promise<PreparedDocument>;
export function prepareDocument(input: ManagedPreparationInput, command: DocumentCommand): Promise<PreparedDocument>;
export function prepareDocument(input: PreparationInput, command: DocumentCommand): Promise<PreparedDocument>;
export async function prepareDocument(input: PreparationInput & Partial<ManagedPreparationInput>, command: DocumentCommand = runDocumentCommand): Promise<PreparedDocument> {
  if (!input.bytes.byteLength || input.bytes.byteLength > MAX_DOCUMENT_BYTES) throw Error('Source byte limit exceeded');
  input.signal?.throwIfAborted();
  const sourceSha256 = sha256(input.bytes);
  const references = checkedReferences(input.references, sourceSha256, input.mimeType);
  if (!references.length) throw Error('Prepared document has no authorized source');
  const versions = ToolVersionsSchema.parse(input.toolVersions);
  const required = input.mimeType.split(';')[0] === 'application/pdf' ? ['node', 'pdfinfo', 'pdftotext', 'pdftoppm', 'tesseract'] : /zip/i.test(input.mimeType) ? ['node', 'python3'] : ['node'];
  if (required.some(tool => !versions[tool])) throw Error('Preparation tool version evidence missing');
  let sourceContext: ParserSourceContext | undefined;
  if (command === runDocumentCommand || input.managedRoot !== undefined) {
    if (!input.managedRoot || !input.policy || !input.sourceBindings?.length) throw Error('Preparation requires authenticated managed source bindings');
    if (input.sourceBindings.some(binding => !('sourceSha256' in binding) || binding.sourceSha256 !== sourceSha256 || !references.some(reference => reference.url === binding.url)) ||
        references.some(reference => !input.sourceBindings!.some(binding => binding.url === reference.url))) throw Error('Preparation source bindings differ from original references');
    // Load host lifecycle only here; parser images do not contain authority state or its module closure.
    const { CIVIC_ACQUISITION_DECISION_ID } = await import('./civic-opt-out.ts');
    await assertPreparedSourcesActive(references, input.policy);
    sourceContext = { ...input.policy, root: input.managedRoot, bindings: input.sourceBindings, decisionId: CIVIC_ACQUISITION_DECISION_ID, kind: 'prepared', purpose: 'document', signal: input.signal };
  }
  if (command === runDocumentCommand) {
    const review = await readParserReview();
    if (versions.parser_isolation !== PARSER_ISOLATION_VERSION || versions.parser_image !== review.imageId || versions.parser_contract !== await parserOutputContractSha256()) throw Error('Preparation parser isolation evidence differs from reviewed sandbox');
  }
  const result = await extractDocumentText(input.bytes, input.mimeType, sourceContext, command);
  input.signal?.throwIfAborted();
  if (sourceContext) await assertPreparedSourcesActive(references, input.policy);
  const body = { version: PREPARED_DOCUMENT_VERSION, municipalityId: input.municipalityId, sourceSha256, sourceBytes: input.bytes.byteLength, mimeType: input.mimeType, references, extractorSha256: input.extractorSha256, toolVersions: versions, text: result.text, textSha256: sha256(result.text), offsetUnit: 'utf16_code_units' as const, textLength: result.text.length, method: result.method, ocrUsed: result.ocrUsed, limitations: result.limitations ?? [] };
  return PreparedDocumentSchema.parse({ ...body, receiptSha256: sha256(canonical(body)) });
}
export function verifyPreparedDocument(raw: unknown, expected: PreparedExpectation, bytes?: Uint8Array): PreparedDocument {
  const receipt = PreparedDocumentSchema.parse(raw);
  const { receiptSha256, ...body } = receipt;
  if (Buffer.byteLength(canonical(receipt)) > MAX_PREPARED_BYTES || Buffer.byteLength(receipt.text) > 4 * 1024 * 1024) throw Error('Prepared document exceeds byte limit');
  if (receiptSha256 !== hashSchema.parse(expected.receiptSha256) || receiptSha256 !== sha256(canonical(body))) throw Error('Prepared receipt hash mismatch');
  if (receipt.sourceSha256 !== expected.sourceSha256 || receipt.municipalityId !== expected.municipalityId || receipt.extractorSha256 !== expected.extractorSha256) throw Error('Prepared document source/extractor identity mismatch');
  if (receipt.textSha256 !== sha256(receipt.text) || receipt.textLength !== receipt.text.length) throw Error('Prepared text hash/UTF16 length mismatch');
  if (canonical(receipt.toolVersions) !== canonical(expected.toolVersions)) throw Error('Prepared document tool versions differ');
  const references = checkedReferences(receipt.references, receipt.sourceSha256, receipt.mimeType);
  if (canonical(references) !== canonical(checkedReferences(expected.references, expected.sourceSha256, receipt.mimeType))) throw Error('Prepared source policy/references differ from frozen plan');
  if (bytes && (bytes.byteLength !== receipt.sourceBytes || sha256(bytes) !== receipt.sourceSha256)) throw Error('Prepared original source bytes differ');
  return receipt;
}
export async function cachePreparedDocument(root: string, receipt: PreparedDocument, options: ManagedAcquisitionLaneOptions): Promise<string> {
  const checked = verifyPreparedDocument(receipt, receipt);
  await assertPreparedSourcesActive(checked.references, options);
  // Host-only lifecycle is intentionally not copied into the parser image.
  const { initializeManagedAcquisitionLane, withManagedSourceWrite } = await import('./civic-opt-out.ts');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const managedRoot = await realpath(root);
  await initializeManagedAcquisitionLane(managedRoot, { kind: 'prepared', ...options });
  const relativePath = `${checked.receiptSha256}.json`, path = join(managedRoot, relativePath);
  const bytes = JSON.stringify(checked) + '\n', contentSha256 = sha256(bytes);
  const entries = checked.references.map(reference => ({ kind: 'prepared_source' as const, relativePath, contentSha256, sourceSha256: reference.sha256, url: reference.url, observationId: reference.id, receiptSha256: checked.receiptSha256, independentAllowed: true }));
  return withManagedSourceWrite(managedRoot, entries, async () => {
    try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      verifyPreparedDocument(JSON.parse(await readFile(path, 'utf8')), checked);
    }
    return path;
  }, options);
}
/** Source text stays on the provisioned authority VM; there is no SSH/Mac read fallback. */
export async function readPreparedDocument(expected: PreparedExpectation, options: CivicPolicyOptions = {}): Promise<PreparedDocument> {
  const hash = hashSchema.parse(expected.receiptSha256);
  await assertPreparedSourcesActive(expected.references, options);
  if (process.platform !== 'linux') throw Error('Prepared source reads require the authoritative Codex VM');
  const path = join(PREPARED_VM_ROOT, hash + '.json');
  // Host-only read admission is separate from parsing; never load it in a parser child.
  const { assertManagedSourceBindings } = await import('./civic-opt-out.ts');
  const bindings = preparedSourceBindings(expected.references, expected.receiptSha256);
  await assertManagedSourceBindings(path, bindings, options);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_PREPARED_BYTES) throw Error('Prepared document exceeds byte limit');
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await handle.stat();
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('Prepared document changed during read');
    await assertManagedSourceBindings(path, bindings, options);
    await assertPreparedSourcesActive(expected.references, options);
    return verifyPreparedDocument(JSON.parse(buffer.subarray(0, total).toString('utf8')), expected);
  } finally { await handle.close(); }
}
