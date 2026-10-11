import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferPreparedDocument, jointExtractionContract } from '../src/district-inference.ts';
import type { DocumentResult } from '../src/district-inference.ts';
import { prepareDocument } from '../src/district-prepared-document.ts';
import type { PreparedDocument, PreparedSourceReference } from '../src/district-prepared-document.ts';
import { createWorkPlan, runWorkPlan } from '../src/district-work-plan.ts';
import { sha256 } from '../src/district-schema.ts';

async function preparedText(text: string): Promise<PreparedDocument> {
  const bytes = Buffer.from(text), sourceSha256 = sha256(bytes);
  const reference: PreparedSourceReference = {
    id: 'synthetic-source-' + sourceSha256, url: 'https://example.org/synthetic-budget-document', sha256: sourceSha256,
    retrievedAt: '2026-10-01T00:00:00.000Z', locator: 'document-sha256:' + sourceSha256, mimeType: 'text/plain', sourceType: 'website',
    policy: { robots: { state: 'allowed', url: 'https://example.org/robots.txt' }, tdm: { state: 'not_declared', evidence: [] }, access: 'public', legalClassification: 'not_assessed', publication: 'facts_with_attribution_only' },
  };
  return prepareDocument({ bytes, municipalityId: 'strausberg', references: [reference], mimeType: 'text/plain', extractorSha256: sha256('synthetic preparation implementation'), toolVersions: { node: process.versions.node } }, async () => { assert.fail('plain text preparation must not execute commands'); });
}

test('oversized prepared documents quarantine before readiness and do not pause remaining provider work', async context => {
  const root = await mkdtemp(join(tmpdir(), 'district-inference-budget-'));
  // Guard the native boundary rather than mocking an inference result: any
  // accidental readiness or generation process is forbidden on every host.
  const spawnGuard = context.mock.method(childProcess, 'spawn', () => { throw Error('Native calls forbidden in document-budget test'); });
  syncBuiltinESMExports();
  try {
    const prepared = await Promise.all([preparedText('x'.repeat(4800 * 81)), preparedText('y'.repeat(4 * 1024 * 1024))]);
    const contract = await jointExtractionContract();
    const plan = createWorkPlan(prepared.map(document => ({ municipalityId: document.municipalityId, sourceSha256: document.sourceSha256, preparedSha256: document.receiptSha256 })), contract, 'codex-only');
    const results: DocumentResult[] = [];
    await runWorkPlan(plan, async (task, pinnedContract, signal) => {
      const document = prepared.find(document => document.sourceSha256 === task.group.sourceSha256)!;
      const result = await inferPreparedDocument({
        taskId: task.id, groupId: task.groupId, purpose: task.purpose, provider: task.provider,
        municipality: { id: 'strausberg', name: 'Strausberg', ags: '12064472', districtId: 'maerkisch-oderland' },
        prepared: document, expected: document, contract: pinnedContract, out: root,
        usage: { ledgerPath: join(root, 'usage.jsonl'), pausePath: join(root, 'pause.json'), signal },
      });
      assert.deepEqual(result.records, []); assert.deepEqual(result.chunks, []);
      assert.equal(result.quarantine.length, 1);
      assert.deepEqual(result.quarantine[0], {
        documentId: 'document:' + document.sourceSha256, municipalityId: 'strausberg', sourceId: document.references[0].id,
        sourceSha256: document.sourceSha256, chunk: null,
        reason: 'Document exceeds model chunk limit; entire document quarantined before model readiness (no truncation or model calls)',
      });
      assert.equal(result.taskId, task.id); assert.equal(result.groupId, task.groupId);
      assert.equal(result.preparedSha256, document.receiptSha256);
      assert.equal(result.promptSha256, contract.promptSha256); assert.equal(result.schemaSha256, contract.schemaSha256);
      results.push(result);
      return { resultSha256: sha256(JSON.stringify(result)), preparedSha256: result.preparedSha256, promptSha256: result.promptSha256, schemaSha256: result.schemaSha256 };
    }, async () => {}, async () => false);
    assert.equal(results.length, 2);
    assert.ok(plan.tasks.every(task => task.state === 'completed' && task.attempts === 1));
    assert.equal(plan.providers['openai-subscription'], 'ready');
    assert.equal(spawnGuard.mock.callCount(), 0);
    assert.deepEqual(await readdir(root), []); // No readiness, usage, answer or record side effects.
  } finally { spawnGuard.mock.restore(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});

test('budget handling does not swallow cancellation, prepared integrity, or operational readiness failures', async context => {
  const root = await mkdtemp(join(tmpdir(), 'district-inference-budget-boundary-'));
  const operationalFailure = Error('Synthetic readiness process failure');
  const spawnGuard = context.mock.method(childProcess, 'spawn', () => { throw operationalFailure; });
  syncBuiltinESMExports();
  try {
    const prepared = await preparedText('x'.repeat(4800 * 81)), contract = await jointExtractionContract();
    const options = {
      taskId: sha256('synthetic task'), groupId: sha256('synthetic group'), purpose: 'production' as const, provider: 'openai-subscription' as const,
      municipality: { id: 'strausberg', name: 'Strausberg', ags: '12064472', districtId: 'maerkisch-oderland' },
      prepared, expected: prepared, contract, out: root,
      usage: { ledgerPath: join(root, 'usage.jsonl'), pausePath: join(root, 'pause.json') },
    };
    const controller = new AbortController(), reason = Error('synthetic cancelled budget document'); controller.abort(reason);
    await assert.rejects(inferPreparedDocument({ ...options, usage: { ...options.usage, signal: controller.signal } }), error => error === reason);
    await assert.rejects(inferPreparedDocument({ ...options, prepared: { ...prepared, textSha256: sha256('tampered') } }), /hash mismatch/);
    assert.equal(spawnGuard.mock.callCount(), 0);
    const small = await preparedText('Strausberg: synthetic document of sufficient length, with no native calls permitted.');
    await assert.rejects(inferPreparedDocument({ ...options, prepared: small, expected: small }), error => process.platform === 'linux' ? error === operationalFailure : error instanceof Error && /authorized host/.test(error.message));
    assert.equal(spawnGuard.mock.callCount(), process.platform === 'linux' ? 1 : 0);
    assert.deepEqual(await readdir(root), []);
  } finally { spawnGuard.mock.restore(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});
