import test from 'node:test';
import assert from 'node:assert/strict';
import {qualityRefreshMain} from '../src/quality-refresh.ts';
import {prepareKnowledgeMain} from '../src/prepare-knowledge.ts';

test('quality refresh requires explicit pinned managed inputs and has no implicit old publication fallback',async()=>{
 await assert.rejects(qualityRefreshMain([]),/explicit managed cache-only inputs required/);
 await assert.rejects(qualityRefreshMain(['--config','unread.json']),/explicit managed cache-only inputs required/);
 await assert.rejects(prepareKnowledgeMain([]),/explicit managed cache-only inputs required/);
});
test('old live and retained-copy refresh switches are rejected before source access',async()=>{
 for(const args of [['--retain-city-snapshot'],['--atlas-register','unread.json'],['--evidence-cache','unread'],['--cities','strausberg']])await assert.rejects(qualityRefreshMain(args),/Unknown option/);
});
