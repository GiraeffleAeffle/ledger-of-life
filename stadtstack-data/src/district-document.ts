import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const execute = promisify(execFile);
export const MAX_DOCUMENT_BYTES = 24 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export type DocumentText = { text: string; ocrUsed: boolean; method: 'pdf_text' | 'pdf_ocr' | 'html' | 'text' | 'json' | 'xml' | 'zip_xml'; limitations?: string[] };
export type DocumentCommand = (file: string, args: string[]) => Promise<string>;
export const runDocumentCommand: DocumentCommand = async (file, args) => {
  try {
    const result = await execute(file, args, { timeout: 120_000, maxBuffer: MAX_TEXT_BYTES, encoding: 'utf8', windowsHide: true });
    return result.stdout;
  } catch (error) {
    // Child-process errors contain arguments and stderr; never print those or source text.
    const code = (error as NodeJS.ErrnoException).code;
    throw Error(code === 'ENOENT' ? `Missing document prerequisite: ${file}` : `Document command failed: ${file}`);
  }
};
export function htmlToDocumentText(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code: string) => {
      const value = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : ' ';
    }).replace(/&(amp|lt|gt|quot|apos|nbsp|auml|ouml|uuml|Auml|Ouml|Uuml|szlig);/g, (_match, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß' } as Record<string, string>)[name] ?? ' ')
    .replace(/\s+/g, ' ').trim();
}
export async function extractDocumentText(bytes: Uint8Array, mimeType: string, command: DocumentCommand = runDocumentCommand): Promise<DocumentText> {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw Error('Document exceeds byte limit');
  if (/^application\/(?:zip|x-zip-compressed)(?:;|$)/i.test(mimeType)) {
    const temporary = await mkdtemp(join(tmpdir(), 'stadtstack-xplan-'));
    try {
      const archive = join(temporary, 'document.zip');
      await writeFile(archive, bytes, { mode: 0o600 });
      // Python's standard ZIP reader never writes members to disk and never resolves external XML entities.
      const script = `import zipfile,json,sys
try:
 with zipfile.ZipFile(sys.argv[1]) as archive:
  files=[item for item in archive.infolist() if not item.is_dir()]
  if len(files)>200 or sum(item.file_size for item in files)>25165824: raise ValueError()
  selected=[item for item in files if item.filename.lower().endswith(('.xml','.gml'))]
  if not selected: print(json.dumps({'error':'Unsupported document ZIP: no XML/GML member'}))
  elif any(item.flag_bits & 1 or item.file_size>4194304 or item.file_size>max(1,item.compress_size)*200 for item in selected): print(json.dumps({'error':'Document ZIP encryption or expansion limit'}))
  elif sum(item.file_size for item in selected)>3145728: print(json.dumps({'error':'Document ZIP text limit exceeded'}))
  else:
   texts=[archive.read(item).decode('utf-8-sig') for item in selected]
   print(json.dumps({'text':'\\\\n\\\\n'.join(texts),'skipped':len(files)-len(selected)},ensure_ascii=False))
except Exception:
 print(json.dumps({'error':'Document ZIP decoding or expansion limit failed'}))`;
      const result = JSON.parse(await command('python3', ['-c', script, archive])) as { text?: string; skipped?: number; error?: string };
      if (result.error) throw Error(result.error);
      if (typeof result.text !== 'string' || result.text.length < 40 || Buffer.byteLength(result.text) > MAX_TEXT_BYTES) throw Error('Document ZIP yielded insufficient or excessive XML/GML text');
      return { text: result.text, ocrUsed: false, method: 'zip_xml', limitations: result.skipped ? [`Only XML/GML members interpreted; ${result.skipped} other archive members were not interpreted.`] : [] };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  if (mimeType.split(';')[0] !== 'application/pdf') {
    const body = Buffer.from(bytes).toString('utf8');
    const method = /html/i.test(mimeType) ? 'html' : /json/i.test(mimeType) ? 'json' : /xml|gml/i.test(mimeType) ? 'xml' : 'text';
    if (!/^(text\/|application\/(?:json|xml|gml\+xml|xhtml\+xml)(?:;|$))/i.test(mimeType)) throw Error('Unsupported document MIME type');
    const text = method === 'html' ? htmlToDocumentText(body) : body.replace(/\r\n?/g, '\n').trim();
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw Error('Document exceeds text limit');
    if (text.length < 40) throw Error('Document has insufficient text');
    return { text, ocrUsed: false, method };
  }
  const temporary = await mkdtemp(join(tmpdir(), 'stadtstack-pdf-'));
  try {
    const pdf = join(temporary, 'document.pdf');
    await writeFile(pdf, bytes, { mode: 0o600 });
    const info = await command('pdfinfo', [pdf]);
    const pageCount = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 80) throw Error('PDF page count missing or exceeds 80-page limit');
    // Reading order joins PDF line hyphenation and keeps newspaper columns apart.
    // Physical -layout output interleaves unrelated columns and breaks quoted words.
    const pages = (await command('pdftotext', ['-enc', 'UTF-8', pdf, '-'])).split('\f');
    let ocrUsed = false;
    const textPages: string[] = [];
    let textBytes = 0;
    for (let index = 0; index < pageCount; index++) {
      let page = pages[index]?.trim() ?? '';
      // Sparse/scanned pages are rendered and OCRed even when other PDF pages have a text layer.
      if ((page.match(/[\p{L}\p{N}]/gu) ?? []).length < 80) {
        const prefix = join(temporary, `page-${index + 1}`);
        await command('pdftoppm', ['-f', String(index + 1), '-l', String(index + 1), '-r', '150', '-scale-to', '2400', '-singlefile', '-png', pdf, prefix]);
        const ocr = await command('tesseract', [`${prefix}.png`, 'stdout', '-l', 'deu+eng', '--psm', '3']);
        if (ocr.trim().length > page.length) page = ocr.trim();
        ocrUsed = true;
      }
      textBytes += Buffer.byteLength(page);
      if (textBytes > MAX_TEXT_BYTES) throw Error('PDF exceeds text limit');
      textPages.push(page);
    }
    const text = textPages.join('\n\n');
    if (textPages.every(page => page.trim().length < 40)) throw Error('PDF text and OCR yielded insufficient text');
    return { text, ocrUsed, method: ocrUsed ? 'pdf_ocr' : 'pdf_text' };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
