// tests/proof-annotate.test.mjs
// Stage-2 contract: annotateWithProof uses [FINDING] grammar (run/expects/observed),
// returns { results, verified_experiments, engine_claimed_experiments }.
// Migrated from Stage-1 ([NEEDS-EXPERIMENT] / executed_experiments / pending_paid).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { annotateWithProof } from '../scripts/lib/proof.mjs';

const repo = () => mkdtempSync(join(tmpdir(), 'storm-annrepo-'));

test('annotateWithProof: a FREE experiment that reproduces -> proven', async () => {
  const results = [{ engine: 'claude', status: 'ok', result: [
    '[FINDING] Bug A',
    '  run: exit 1',
    '  expects: exit!=0',
    '  observed: exited 1',
  ].join('\n') }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  const f = out.results[0].findings[0];
  assert.equal(f.tag, 'proven');
  assert.equal(out.verified_experiments.length, 1);
  assert.equal(out.verified_experiments[0].matched, true);
});

test('annotateWithProof: a FREE experiment that does NOT reproduce -> disproven', async () => {
  const results = [{ engine: 'claude', status: 'ok', result: [
    '[FINDING] Bug B',
    '  run: exit 0',
    '  expects: exit!=0',
    '  observed: exited 0',
  ].join('\n') }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  assert.equal(out.results[0].findings[0].tag, 'disproven');
});

test('annotateWithProof: a networked experiment is NOT re-run, goes to engine-claimed', async () => {
  const results = [{ engine: 'glm', status: 'ok', result: [
    '[FINDING] Bug C',
    '  run: curl https://api.openai.com/v1/x',
    '  expects: exit==0',
    '  observed: exited 0',
  ].join('\n') }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  assert.equal(out.results[0].findings[0].tag, 'engine-claimed');
  assert.equal(out.engine_claimed_experiments.length, 1);
  assert.equal(out.verified_experiments.length, 0);
});

test('annotateWithProof: UNPROVEN-CANNOT is passed through as unproven-cannot', async () => {
  const results = [{ engine: 'codex', status: 'ok', result: '[UNPROVEN-CANNOT] trust me bro — why: nondeterministic' }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  assert.equal(out.results[0].findings[0].tag, 'unproven-cannot');
});

test('annotateWithProof: non-ok engine result is passed through untouched', async () => {
  const results = [{ engine: 'x', status: 'stalled', error: 'no output' }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  assert.equal(out.results[0].status, 'stalled');
  assert.equal(out.results[0].findings, undefined);
});

test('annotateWithProof: mixed ok+stalled results — stalled passed through, ok finding still proven', async () => {
  const results = [
    { engine: 'claude', status: 'ok', result: [
      '[FINDING] Bug ok',
      '  run: exit 1',
      '  expects: exit!=0',
      '  observed: exited 1',
    ].join('\n') },
    { engine: 'gemini', status: 'stalled', error: 'no output' },
  ];
  const out = await annotateWithProof(results, { repoPath: mkdtempSync(join(tmpdir(), 'storm-annrepo-')), timeoutMs: 5000 });
  const stalled = out.results.find((r) => r.engine === 'gemini');
  assert.equal(stalled.status, 'stalled');
  assert.equal(stalled.findings, undefined, 'stalled engine must not have a findings key');
  const okResult = out.results.find((r) => r.engine === 'claude');
  assert.ok(Array.isArray(okResult.findings), 'ok engine must have findings');
  assert.equal(okResult.findings[0].tag, 'proven');
});

test('annotateWithProof: two findings in one ok result — one proven, one unproven-cannot', async () => {
  const results = [{ engine: 'codex', status: 'ok', result: [
    '[FINDING] Repro finding',
    '  run: exit 1',
    '  expects: exit!=0',
    '  observed: exited 1',
    '[UNPROVEN-CANNOT] Hard-to-verify claim — why: requires manual inspection',
  ].join('\n') }];
  const out = await annotateWithProof(results, { repoPath: mkdtempSync(join(tmpdir(), 'storm-annrepo-')), timeoutMs: 5000 });
  const findings = out.results[0].findings;
  assert.equal(findings.length, 2, `expected 2 findings, got ${findings.length}`);
  assert.equal(findings[0].tag, 'proven', `first finding should be proven, got ${findings[0].tag}`);
  assert.equal(findings[1].tag, 'unproven-cannot', `second finding should be unproven-cannot, got ${findings[1].tag}`);
});

test('annotateWithProof: a timed-out experiment must be disproven, never proven (CRITICAL verify-dont-trust)', async () => {
  const results = [{ engine: 'claude', status: 'ok', result: [
    '[FINDING] Hung process',
    '  run: sleep 30',
    '  expects: exit!=0',
    '  observed: unknown',
  ].join('\n') }];
  const out = await annotateWithProof(results, { repoPath: mkdtempSync(join(tmpdir(), 'storm-timeout-')), timeoutMs: 300 });
  const f = out.results[0].findings[0];
  assert.equal(f.tag, 'disproven', 'timed-out experiment must be disproven, not proven');
  assert.equal(out.verified_experiments.length, 1);
  assert.equal(out.verified_experiments[0].timedOut, true, 'experiment must be recorded as timed out');
  assert.equal(out.verified_experiments[0].matched, false, 'matched must be false for timed-out experiment');
});
