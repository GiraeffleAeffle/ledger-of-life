import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

type McpResponse = {
 id?: number;
 error?: {code: number; message: string};
 result?: {content?: Array<{text: string}>; isError?: boolean};
};

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

test('MCP unknown city and signal IDs return typed tool errors without terminating the server', async () => {
 const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../src/mcp.ts', import.meta.url))], {
  cwd: packageDirectory, stdio: ['pipe', 'pipe', 'pipe'],
 });
 let buffer = '';
 const waiting = new Map<number, (message: McpResponse) => void>();
 const stdin = child.stdin!;
 const stdout = child.stdout!;
 stdout.setEncoding('utf8');
 stdout.on('data', chunk => {
  buffer += chunk;
  for (;;) {
   const end = buffer.indexOf('\n');
   if (end < 0) break;
   const line = buffer.slice(0, end);
   buffer = buffer.slice(end + 1);
   if (!line) continue;
   const message = JSON.parse(line) as McpResponse;
   if (typeof message.id === 'number') waiting.get(message.id)?.(message);
  }
 });
 const request = (id: number, method: string, params: Record<string, unknown> = {}) => {
  const {promise, resolve, reject} = Promise.withResolvers<McpResponse>();
  // This is a protocol-process watchdog, not a timing assertion; the test awaits the matching JSON-RPC response.
  const timer = setTimeout(() => {
   waiting.delete(id);
   reject(new Error(`MCP ${method} timed out`));
  }, 10_000);
  waiting.set(id, message => { clearTimeout(timer); waiting.delete(id); resolve(message); });
  stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`);
  return promise;
 };
 try {
  const initialized = await request(1, 'initialize', {
   protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'behavior-test', version: '1'},
  });
  assert.equal(initialized.error, undefined);
  stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})}\n`);
  const unknownCity = await request(3, 'tools/call', {name: 'search_signals', arguments: {cityId: 'no-such-city'}});
  assert.equal(unknownCity.result?.isError, true);
  const unknown = JSON.parse(unknownCity.result!.content![0].text) as {error: string};
  assert.equal(unknown.error, 'unknown_city');
  const missingSignal = await request(4, 'tools/call', {name: 'get_sources', arguments: {id: 'missing:signal'}});
  assert.equal(missingSignal.result?.isError, true);
  const missing = JSON.parse(missingSignal.result!.content![0].text) as {error: string};
  assert.equal(missing.error, 'signal_not_found');
 } finally {
  if (child.exitCode === null) {
   const exited = once(child, 'exit');
   child.kill('SIGTERM');
   await exited;
  }
 }
});
