import { z } from 'zod';
import { withParserSandbox, type ParserSourceContext } from './district-parser-isolation.ts';
export const MAX_DOCUMENT_BYTES = 24 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const DocumentTextSchema = z.object({ text: z.string(), ocrUsed: z.boolean(), method: z.enum(['pdf_text', 'pdf_ocr', 'html', 'text', 'json', 'xml', 'zip_xml']), limitations: z.array(z.string()).optional() }).strict();
export type DocumentText = z.infer<typeof DocumentTextSchema>;
export type DocumentCommand = (file: string, args: string[]) => Promise<string>;
export const runDocumentCommand: DocumentCommand = async (file, args) =>
  withParserSandbox(null, async sandbox => (await sandbox.run(file, args)).stdout);
function assertSafeXml(text: string) {
  if (text.includes('\0') || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw Error('XML DTD/entity declarations or unsupported encoding are not permitted');
}
export function htmlToDocumentText(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code: string) => {
      const value = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : ' ';
    }).replace(/&(amp|lt|gt|quot|apos|nbsp|auml|ouml|uuml|Auml|Ouml|Uuml|szlig);/g, (_match, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß' } as Record<string, string>)[name] ?? ' ')
    .replace(/\s+/g, ' ').trim();
}
export async function extractDocumentText(bytes: Uint8Array, mimeType: string, sourceContext?: ParserSourceContext, command: DocumentCommand = runDocumentCommand): Promise<DocumentText> {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw Error('Document exceeds byte limit');
  if (/^application\/(?:zip|x-zip-compressed)(?:;|$)/i.test(mimeType)) {
    const archive = '/input/document';
    const parse = async (execute: DocumentCommand): Promise<DocumentText> => {
      // No members are extracted; reject unsafe names even for uninterpreted members.
      const script = `import zipfile,json,sys,re,stat
try:
 with zipfile.ZipFile(sys.argv[1]) as archive:
  items=archive.infolist()
  if len(items)>200 or sum(item.file_size for item in items)>25165824: raise ValueError()
  for item in items:
   name=item.orig_filename
   parts=name.rstrip('/').split('/')
   mode=item.external_attr>>16
   if not name or '\\x00' in name or name.startswith(('/','\\\\')) or '\\\\' in name or any(part in ('','..','.') for part in parts) or re.match(r'^[A-Za-z]:',name) or stat.S_ISLNK(mode): raise ValueError()
   if item.flag_bits & 1 or item.file_size>max(1,item.compress_size)*200: raise ValueError()
  files=[item for item in items if not item.is_dir()]
  selected=[item for item in files if item.filename.lower().endswith(('.xml','.gml'))]
  if not selected: print(json.dumps({'error':'Unsupported document ZIP: no XML/GML member'}))
  elif any(item.file_size>4194304 for item in selected) or sum(item.file_size for item in selected)>3145728: print(json.dumps({'error':'Document ZIP text limit exceeded'}))
  else:
   texts=[archive.read(item).decode('utf-8-sig') for item in selected]
   if any('\\x00' in text or re.search(r'<!\\s*(DOCTYPE|ENTITY)\\b',text,re.I) for text in texts): raise ValueError()
   print(json.dumps({'text':'\\n\\n'.join(texts),'skipped':len(files)-len(selected)},ensure_ascii=False))
except Exception:
 print(json.dumps({'error':'Document ZIP decoding, XML safety or archive limit failed'}))`;
      const result = JSON.parse(await execute('python3', ['-c', script, archive])) as { text?: string; skipped?: number; error?: string };
      if (result.error) throw Error(result.error);
      if (typeof result.text !== 'string' || result.text.length < 40 || Buffer.byteLength(result.text) > MAX_TEXT_BYTES) throw Error('Document ZIP yielded insufficient or excessive XML/GML text');
      assertSafeXml(result.text);
      return { text: result.text, ocrUsed: false, method: 'zip_xml', limitations: result.skipped ? [`Only XML/GML members interpreted; ${result.skipped} other archive members were not interpreted.`] : [] };
    };
    return command === runDocumentCommand
      ? await withParserSandbox(bytes, sandbox => parse(async (file, args) => (await sandbox.run(file, args)).stdout), sourceContext)
      : await parse(command);
  }
  if (mimeType.split(';')[0] !== 'application/pdf') {
    if (!/^(text\/|application\/(?:json|xml|gml\+xml|xhtml\+xml)(?:;|$))/i.test(mimeType)) throw Error('Unsupported document MIME type');
    if (command === runDocumentCommand) {
      return await withParserSandbox(bytes, async sandbox => {
        const response = JSON.parse((await sandbox.run('node', ['--experimental-strip-types', '/opt/stadtstack/src/district-document-parser-worker.ts', '/input/document', mimeType])).stdout) as { ok?: boolean; document?: unknown };
        if (response.ok !== true) throw Error('Document text decoding, XML safety or text limit failed');
        return DocumentTextSchema.parse(response.document);
      }, sourceContext);
    }
    const body = Buffer.from(bytes).toString('utf8');
    const method = /html/i.test(mimeType) ? 'html' : /json/i.test(mimeType) ? 'json' : /xml|gml/i.test(mimeType) ? 'xml' : 'text';
    if (/xml|gml/i.test(mimeType)) assertSafeXml(body);
    const text = method === 'html' ? htmlToDocumentText(body) : body.replace(/\r\n?/g, '\n').trim();
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw Error('Document exceeds text limit');
    if (text.length < 40) throw Error('Document has insufficient text');
    return { text, ocrUsed: false, method };
  }
  const pdf = '/input/document';
  const parse = async (execute: DocumentCommand): Promise<DocumentText> => {
    const info = await execute('pdfinfo', [pdf]);
    const counts = [...info.matchAll(/^Pages:\s+(\d+)\s*$/gm)];
    const pageCount = counts.length === 1 ? Number(counts[0][1]) : NaN;
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 80) throw Error('PDF page count missing or exceeds 80-page limit');
    // Reading order joins PDF line hyphenation and keeps newspaper columns apart.
    // Physical -layout output interleaves unrelated columns and breaks quoted words.
    const pages = (await execute('pdftotext', ['-f', '1', '-l', String(pageCount), '-enc', 'UTF-8', pdf, '-'])).split('\f');
    let ocrUsed = false;
    const textPages: string[] = [];
    let textBytes = 0;
    for (let index = 0; index < pageCount; index++) {
      let page = pages[index]?.trim() ?? '';
      // Sparse/scanned pages are rendered and OCRed even when other PDF pages have a text layer.
      if ((page.match(/[\p{L}\p{N}]/gu) ?? []).length < 80) {
        const prefix = `/scratch/page-${index + 1}`;
        await execute('pdftoppm', ['-f', String(index + 1), '-l', String(index + 1), '-r', '150', '-scale-to', '2400', '-singlefile', '-png', pdf, prefix]);
        const ocr = await execute('tesseract', [`${prefix}.png`, 'stdout', '-l', 'deu+eng', '--psm', '3']);
        if (ocr.trim().length > page.length) page = ocr.trim();
        ocrUsed = true;
      }
      textBytes += Buffer.byteLength(page);
      if (textBytes > MAX_TEXT_BYTES) throw Error('PDF exceeds text limit');
      textPages.push(page);
    }
    const text = textPages.join('\n\n');
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw Error('PDF exceeds text limit');
    if (textPages.every(page => page.trim().length < 40)) throw Error('PDF text and OCR yielded insufficient text');
    return { text, ocrUsed, method: ocrUsed ? 'pdf_ocr' : 'pdf_text' };
  };
  return command === runDocumentCommand
    ? await withParserSandbox(bytes, sandbox => parse(async (file, args) => (await sandbox.run(file, args)).stdout), sourceContext)
    : await parse(command);
}
