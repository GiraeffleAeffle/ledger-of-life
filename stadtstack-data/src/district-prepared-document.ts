import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { extractDocumentText, runDocumentCommand, MAX_DOCUMENT_BYTES, type DocumentCommand } from './district-document.ts';
import { SourceAccessPolicySchema, assertSubscriptionSourcePolicy, sha256, hashSchema } from './district-schema.ts';
const execute = promisify(execFile);
export const PREPARED_DOCUMENT_VERSION = 'district-prepared-v1';
export const PREPARED_VM_ROOT = '/home/max/civic-knowledge-slice/stadtstack-data/cache/districts/prepared';
const MAX_PREPARED_BYTES = 6 * 1024 * 1024;
const ReferenceSchema = z.object({ id: z.string().min(1), url: z.url(), sha256: hashSchema, retrievedAt: z.iso.datetime(), locator: z.string().min(1), mimeType: z.string().min(1), sourceType: z.enum(['council', 'participation', 'gazette', 'website']), policy: SourceAccessPolicySchema }).strict();
export type PreparedSourceReference = z.infer<typeof ReferenceSchema>;
const ToolVersionsSchema = z.record(z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/), z.string().min(1).max(300));
export const PreparedDocumentSchema = z.object({
  version: z.literal(PREPARED_DOCUMENT_VERSION), municipalityId: z.string().regex(/^[a-z0-9-]+$/), sourceSha256: hashSchema, sourceBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES), mimeType: z.string().min(1), references: z.array(ReferenceSchema).min(1),
  extractorSha256: hashSchema, toolVersions: ToolVersionsSchema, text: z.string().min(40), textSha256: hashSchema, offsetUnit: z.literal('utf16_code_units'), textLength: z.number().int().nonnegative(),
  method: z.enum(['pdf_text', 'pdf_ocr', 'html', 'text', 'json', 'xml', 'zip_xml']), ocrUsed: z.boolean(), limitations: z.array(z.string()), receiptSha256: hashSchema,
}).strict();
export type PreparedDocument = z.infer<typeof PreparedDocumentSchema>;
export type PreparedExpectation = { receiptSha256: string; municipalityId: string; sourceSha256: string; extractorSha256: string; references: PreparedSourceReference[]; toolVersions: Record<string, string> };
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
export async function preparationExtractorSha256(): Promise<string> {
  return sha256(canonical(await Promise.all(['district-document.ts', 'district-prepared-document.ts'].map(async file => sha256(await readFile(new URL(file, import.meta.url)))))));
}
export async function collectPreparationToolVersions(mimeType: string): Promise<Record<string, string>> {
  const tools = mimeType.split(';')[0] === 'application/pdf' ? ['pdfinfo', 'pdftotext', 'pdftoppm', 'tesseract'] : /zip/i.test(mimeType) ? ['python3'] : [];
  const versions: Record<string, string> = { node: process.versions.node };
  for (const tool of tools) {
    let output: string;
    try { const result = await execute(tool, [tool.startsWith('pdf') ? '-v' : '--version'], { timeout: 10_000, maxBuffer: 16 * 1024, encoding: 'utf8' }); output = result.stdout + '\n' + result.stderr; }
    catch { throw Error(`Document tool version unavailable: ${tool}`); }
    const line = output.split('\n').find(line => line.trim());
    if (!line || line.length > 300 || !/\d/.test(line)) throw Error(`Document tool version invalid: ${tool}`);
    versions[tool] = line.trim();
  }
  return versions;
}
export async function readAuthorizedSourceBytes(rawRoot: string, path: string, expectedSha256: string): Promise<Uint8Array> {
  hashSchema.parse(expectedSha256);
  const [root, actual] = await Promise.all([realpath(rawRoot), realpath(path)]);
  const contained = relative(root, actual);
  if (!contained || contained.startsWith('..') || isAbsolute(contained)) throw Error('Source path escapes authorized raw root');
  const size = (await stat(actual)).size;
  if (size < 1 || size > MAX_DOCUMENT_BYTES) throw Error('Source byte limit exceeded');
  const bytes = await readFile(actual);
  if (bytes.byteLength > MAX_DOCUMENT_BYTES || sha256(bytes) !== expectedSha256) throw Error('Source bytes differ from frozen index');
  return bytes;
}
export async function prepareDocument(input: { bytes: Uint8Array; municipalityId: string; references: PreparedSourceReference[]; mimeType: string; extractorSha256: string; toolVersions: Record<string, string> }, command: DocumentCommand = runDocumentCommand): Promise<PreparedDocument> {
  if (!input.bytes.byteLength || input.bytes.byteLength > MAX_DOCUMENT_BYTES) throw Error('Source byte limit exceeded');
  const sourceSha256 = sha256(input.bytes);
  const references = checkedReferences(input.references, sourceSha256, input.mimeType);
  if (!references.length) throw Error('Prepared document has no authorized source');
  const versions = ToolVersionsSchema.parse(input.toolVersions);
  const required = input.mimeType.split(';')[0] === 'application/pdf' ? ['node', 'pdfinfo', 'pdftotext', 'pdftoppm', 'tesseract'] : /zip/i.test(input.mimeType) ? ['node', 'python3'] : ['node'];
  if (required.some(tool => !versions[tool])) throw Error('Preparation tool version evidence missing');
  const result = await extractDocumentText(input.bytes, input.mimeType, command);
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
export async function cachePreparedDocument(root: string, receipt: PreparedDocument): Promise<string> {
  const checked = verifyPreparedDocument(receipt, receipt);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${checked.receiptSha256}.json`);
  try { await writeFile(path, JSON.stringify(checked) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    verifyPreparedDocument(JSON.parse(await readFile(path, 'utf8')), checked);
  }
  return path;
}
export async function fetchPreparedDocument(expected: PreparedExpectation): Promise<PreparedDocument> {
  const hash = hashSchema.parse(expected.receiptSha256);
  let text: string;
  try {
    const result = await execute('/usr/bin/ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', 'codex-workstation', `cat -- ${PREPARED_VM_ROOT}/${hash}.json`], { timeout: 60_000, maxBuffer: MAX_PREPARED_BYTES, encoding: 'utf8' });
    text = result.stdout;
  } catch { throw Error('Authenticated prepared-document SSH transport failed'); }
  // The pinned receipt digest must arrive from the trusted VM preparation plan, not from this payload itself.
  return verifyPreparedDocument(JSON.parse(text), expected);
}
