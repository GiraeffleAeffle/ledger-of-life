import { readFile, lstat } from 'node:fs/promises';
import { extractDocumentText, MAX_DOCUMENT_BYTES, type DocumentCommand } from './district-document.ts';

// Reuse the deterministic text branch; this worker cannot launch a nested/host parser.
const noSubprocess: DocumentCommand = async () => { throw Error('Nested document parser is not permitted'); };
async function main() {
  const [artifact, mimeType, ...extra] = process.argv.slice(2);
  if (artifact !== '/input/document' || !mimeType || extra.length ||
      !/^(text\/|application\/(?:json|xml|gml\+xml|xhtml\+xml)(?:;|$))/i.test(mimeType)) throw Error('Document parser request rejected');
  const metadata = await lstat(artifact);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_DOCUMENT_BYTES) throw Error('Document parser input limit');
  const bytes = await readFile(artifact);
  if (bytes.length !== metadata.size) throw Error('Document parser input changed');
  const result = await extractDocumentText(bytes, mimeType, undefined, noSubprocess);
  process.stdout.write(JSON.stringify({ ok: true, document: result }) + '\n');
}
await main().catch(() => {
  // Keep source text and engine diagnostics out of failure responses.
  process.stdout.write(JSON.stringify({ ok: false, reason: 'Document text decoding, XML safety or text limit failed' }) + '\n');
});
