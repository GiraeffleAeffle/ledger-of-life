import { z } from 'zod';

// Pure metadata contract: policy/schema loading must not import parser or authority execution.
export const DOCUMENT_ORIGIN_CLASSIFIER_VERSION = 'document-origin-rules-v2';
export const DocumentOriginSchema = z.object({
  classification: z.enum(['official_work', 'third_party', 'mixed', 'unknown']),
  method: z.literal('rules'),
  classifierVersion: z.string().min(1).max(80),
  url: z.url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  classifiedAt: z.iso.datetime(),
  evidence: z.array(z.object({ locator: z.string().min(1).max(100), value: z.string().min(1).max(160) }).strict()).max(64),
}).strict();
export type DocumentOriginClassification = z.infer<typeof DocumentOriginSchema>;

export const DOCUMENT_ORIGIN_INPUT_TOKEN = 'document';
export interface OParlOriginContext {
  bodyId: string;
  bodyName: string;
  /** Authorized original API request, not an unrelated redirect destination. */
  apiUrl: string;
}
export interface DocumentOriginInput {
  url: string;
  mimeType: string;
  bytes: Uint8Array;
  title?: string;
  linkText?: string;
  municipalityName?: string;
  /** Caller strings may identify conflicts but cannot establish an issuer. */
  administrativeOriginEvidence?: string | string[];
  oparlContext?: OParlOriginContext;
}
export type DocumentOriginCommand = (file:'pdfinfo'|'pdftotext',args:string[])=>Promise<string>;
export type PdfOriginEvidence = {text:string;author:string;producer:string;title:string};
export type DocumentOriginPdfInspector = (sourceSha256:string)=>Promise<PdfOriginEvidence>;
