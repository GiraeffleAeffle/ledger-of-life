/** Synthetic BOB-style escaped JSON, never bytes or receipts from a live source. */
export function largeBobInventory():Buffer {
 const rows=[{id:'ratzeburg',municipalCode:'01053100',padding:'LARGE_SYNTHETIC_PADDING'},{id:'moelln',municipalCode:'01053090'},{id:'schwarzenbek',municipalCode:'01053116'},{id:'neighbor',municipalCode:'01053021'}];
 const escape=(text:string)=>text.replace(/[\s\S]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
 const encoded=escape(JSON.stringify(rows)).replace(escape('LARGE_SYNTHETIC_PADDING'),'\\u0078'.repeat(1_750_000));
 return Buffer.from(`<html><head><title>BOB-SH Beteiligung</title></head><body><main>Bauleitplanung</main><script>var initialProcedures = JSON.parse('${encoded}');</script></body></html>`);
}
