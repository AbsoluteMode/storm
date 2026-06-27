// tests/proof-annotate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { annotateWithProof } from '../scripts/lib/proof.mjs';

const repo = () => mkdtempSync(join(tmpdir(), 'storm-annrepo-'));

test('annotateWithProof: a FREE experiment that reproduces -> proven', async () => {
  const results = [{ engine: 'claude', status: 'ok', result: [
    '[NEEDS-EXPERIMENT] Bug A',
    '  run: exit 1',
    '  expects: exit!=0',
    '  cost: free',
  ].join('\n') }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  const f = out.results[0].findings[0];
  assert.equal(f.tag, 'proven');
  assert.equal(out.executed_experiments.length, 1);
  assert.equal(out.executed_experiments[0].matched, true);
});

test('annotateWithProof: a FREE experiment that does NOT reproduce -> disproven', async () => {
  const results = [{ engine: 'claude', status: 'ok', result: [
    '[NEEDS-EXPERIMENT] Bug B',
    '  run: exit 0',
    '  expects: exit!=0',
    '  cost: free',
  ].join('\n') }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  assert.equal(out.results[0].findings[0].tag, 'disproven');
});

test('annotateWithProof: a PAID experiment is NOT run, goes to pending', async () => {
  const results = [{ engine: 'glm', status: 'ok', result: [
    '[NEEDS-EXPERIMENT] Bug C',
    '  run: curl https://api.openai.com/v1/x',
    '  expects: exit==0',
    '  cost: free',
  ].join('\n') }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  assert.equal(out.results[0].findings[0].tag, 'unproven-needs-paid');
  assert.equal(out.pending_paid_experiments.length, 1);
  assert.equal(out.executed_experiments.length, 0);
});

test('annotateWithProof: engine-claimed PROVEN is downgraded to unproven-cannot', async () => {
  const results = [{ engine: 'codex', status: 'ok', result: '[PROVEN] trust me bro' }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  assert.equal(out.results[0].findings[0].tag, 'unproven-cannot');
});

test('annotateWithProof: non-ok engine result is passed through untouched', async () => {
  const results = [{ engine: 'x', status: 'stalled', error: 'no output' }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  assert.equal(out.results[0].status, 'stalled');
  assert.equal(out.results[0].findings, undefined);
});

test('annotateWithProof: a timed-out experiment must be disproven, never proven (CRITICAL verify-dont-trust)', async () => {
  // sleep 30 with a 300ms timeout -> timedOut=true, exitCode=null.
  // The finding expects exit!=0 which null would falsely satisfy without the guard.
  const results = [{ engine: 'claude', status: 'ok', result: [
    '[NEEDS-EXPERIMENT] Hung process',
    '  run: sleep 30',
    '  expects: exit!=0',
    '  cost: free',
  ].join('\n') }];
  const out = await annotateWithProof(results, { repoPath: mkdtempSync(join(tmpdir(), 'storm-timeout-')), timeoutMs: 300 });
  const f = out.results[0].findings[0];
  assert.equal(f.tag, 'disproven', 'timed-out experiment must be disproven, not proven');
  assert.equal(out.executed_experiments.length, 1);
  assert.equal(out.executed_experiments[0].timedOut, true, 'experiment must be recorded as timed out');
  assert.equal(out.executed_experiments[0].matched, false, 'matched must be false for timed-out experiment');
});
