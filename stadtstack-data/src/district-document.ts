import {createHash} from 'node:crypto';
import {join} from 'node:path';
import type {ManagedSourceContext,ManagedSourceScratch} from './civic-opt-out.ts';
export const MAX_DOCUMENT_BYTES = 24 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export type DocumentText = { text: string; ocrUsed: boolean; method: 'pdf_text' | 'pdf_ocr' | 'html' | 'text' | 'json' | 'xml' | 'zip_xml'; limitations?: string[] };
export type DocumentCommand = (file: string, args: string[], scope: ManagedSourceScratch) => Promise<string>;
export const runDocumentCommand: DocumentCommand = async (file, args, scope) => {
  // Static lifecycle imports would cycle through schema -> origin -> document.
  const {CivicPolicyStateError,HostOptedOutError}=await import('./civic-opt-out.ts');
  try {
    await scope.assertActive();const child=await scope.spawn(file,args);
    let output='',size=0,failed=false;const stop=()=>{failed=true;try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{/* Already exited. */}};
    const timer=setTimeout(stop,120_000),abort=()=>stop();scope.signal.addEventListener('abort',abort,{once:true});if(scope.signal.aborted)abort();
    try {
      child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{size+=Buffer.byteLength(chunk);if(size>MAX_TEXT_BYTES)stop();else if(!failed)output+=chunk;});
      child.stderr.resume();child.stdin.on('error',stop);child.stdin.end();
      const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
      await scope.assertActive();
      if(failed||code!==0)throw Error(code===127?'missing':'failed');
      return output;
    } finally {clearTimeout(timer);scope.signal.removeEventListener('abort',abort);}
  } catch (error) {
    if(error instanceof CivicPolicyStateError||error instanceof HostOptedOutError)throw error;
    // Native diagnostics can contain source bytes/arguments; never expose them.
    throw Error(error instanceof Error&&error.message==='missing'?`Missing document prerequisite: ${file}`:`Document command failed: ${file}`);
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
export async function extractDocumentText(bytes: Uint8Array, mimeType: string, context: ManagedSourceContext, command: DocumentCommand = runDocumentCommand): Promise<DocumentText> {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw Error('Document exceeds byte limit');
  // Deferred for the real schema/origin/document initialization cycle.
  const {withManagedSourceScratch,CivicPolicyStateError}=await import('./civic-opt-out.ts');
  const sourceSha256=createHash('sha256').update(bytes).digest('hex');
  if(!context?.root||!context.bindings?.length||context.bindings.some(binding=>{
    if('kind' in binding){
      if(binding.kind==='authenticated_git_snapshot'||binding.kind==='operator_registry_config')return true;
      if(binding.kind==='retained_publication')return binding.publication.memberSha256!==sourceSha256||binding.publication.memberBytes!==bytes.byteLength;
    }
    return binding.sourceSha256!==sourceSha256;
  }))throw new CivicPolicyStateError('SCRATCH_SOURCE_BINDING_MISMATCH');
  return withManagedSourceScratch<DocumentText>(context.root,context.bindings,async scope=>{
    const invoke=async(file:string,args:string[])=>{await scope.assertActive();const result=await command(file,args,scope);await scope.assertActive();return result;};
    if (/^application\/(?:zip|x-zip-compressed)(?:;|$)/i.test(mimeType)) {
      const archive = join(scope.directory, 'document.zip');await scope.writeSource('document.zip',bytes);
      // ZIP members remain in memory; neither paths nor external XML entities are expanded.
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
      const result = JSON.parse(await invoke('python3', ['-c', script, archive])) as { text?: string; skipped?: number; error?: string };
      if (result.error) throw Error(result.error);
      if (typeof result.text !== 'string' || result.text.length < 40 || Buffer.byteLength(result.text) > MAX_TEXT_BYTES) throw Error('Document ZIP yielded insufficient or excessive XML/GML text');
      return { text: result.text, ocrUsed: false, method: 'zip_xml', limitations: result.skipped ? [`Only XML/GML members interpreted; ${result.skipped} other archive members were not interpreted.`] : [] };
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
    const pdf = join(scope.directory, 'document.pdf');await scope.writeSource('document.pdf',bytes);
    const info = await invoke('pdfinfo', [pdf]);
    const pageCount = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 80) throw Error('PDF page count missing or exceeds 80-page limit');
    const pages = (await invoke('pdftotext', ['-enc', 'UTF-8', pdf, '-'])).split('\f');
    let ocrUsed = false,textBytes = 0;const textPages: string[] = [];
    for (let index = 0; index < pageCount; index++) {
      let page = pages[index]?.trim() ?? '';
      if ((page.match(/[\p{L}\p{N}]/gu) ?? []).length < 80) {
        const prefix = join(scope.directory, `page-${index + 1}`);
        await invoke('pdftoppm', ['-f', String(index + 1), '-l', String(index + 1), '-r', '150', '-scale-to', '2400', '-singlefile', '-png', pdf, prefix]);
        const ocr = await invoke('tesseract', [`${prefix}.png`, 'stdout', '-l', 'deu+eng', '--psm', '3']);
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
  },{...context,purpose:'document'});
}
